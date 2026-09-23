// Живой прогон признака «страница передала действие приложению» (handoff)
// в настоящем браузере. Мок из smoke.mjs проверяет логику service worker'а,
// но не то, что событие `navigate` Navigation API вообще доходит до
// content.js, живущего в изолированном мире, — а на этом держится вся
// защита Telegram-вкладок.
//
// Как устроено. Тот же приём, что в live-guard.mjs: локальный HTTPS и подмена
// DNS, чтобы настоящий адрес t.me вёл на заглушку. Отличие одно: доступ
// к t.me опциональный, а выдать его без диалога браузера автоматика не может.
// Поэтому расширение копируется во временную папку, и в копии t.me объявлен
// обязательным. Код расширения не меняется ни на байт — только манифест
// и флаг `optional` у записи telegram в копии реестра.
//
// Вместо `tg://` страница ведёт на схему без обработчика (`mtc-test://`):
// на машине разработчика настоящий Telegram иначе запустился бы. Признак
// срабатывает на любую схему, которая открывает внешнее приложение, так что
// проверяется тот же путь.
//
// Четыре вкладки:
//   read  — пост, кнопку не нажимали        → обязана выжить;
//   click — клик по ссылке на приложение     → обязана закрыться;
//   js    — переход скриптом location.href   → обязана закрыться;
//   feed  — лента t.me/s/…, клик был         → гейт её не пропускает, выжить.
//
// Запуск: node test/live-handoff.mjs   (≈1 минута, окно уводится за экран)

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 9335;
const HTTPS_PORT = 8444;
const HOST = "t.me";

const CANDIDATES = [
  "/Applications/Yandex.app/Contents/MacOS/Yandex",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const chromePath = process.env.CHROME || CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error("не нашёл браузер; задайте CHROME=/путь/к/бинарнику");
  process.exit(2);
}

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- тестовая копия расширения: t.me обязательный ---
// realpath: на macOS tmpdir лежит под симлинком /var → /private/var, а id
// распакованного расширения браузер считает от настоящего пути.
const EXT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmc-handoff-ext-")));
fs.cpSync(path.join(root, "extension"), EXT, { recursive: true });
const registryPath = path.join(EXT, "platforms.js");
const registry = fs.readFileSync(registryPath, "utf8");
const patched = registry.replace(/(id: "telegram",\n\s+)optional: true,\n/, "$1");
if (patched === registry) {
  console.error("не нашёл запись telegram с optional: true — реестр поменялся, поправьте тест");
  process.exit(2);
}
fs.writeFileSync(registryPath, patched);
const manifestPath = path.join(EXT, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.host_permissions.push("https://t.me/*");
for (const cs of manifest.content_scripts) cs.matches.push("https://t.me/*");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const extId = [...crypto.createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 0xf])
  .map((n) => String.fromCharCode(97 + n))
  .join("");

// --- локальный HTTPS вместо t.me ---
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmc-cert-"));
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", path.join(certDir, "key.pem"),
  "-out", path.join(certDir, "cert.pem"),
  "-days", "1", "-subj", `/CN=${HOST}`,
], { stdio: "ignore" });

// Разметка как у настоящего t.me: карточка и кнопка-ссылка на приложение.
const POST = `<!doctype html><meta charset=utf-8><title>Telegram: View @durov</title>
<p>Пост, который открыли почитать.</p>
<a id=open href="mtc-test://resolve?domain=durov&post=100">Open in Telegram</a>`;

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(certDir, "key.pem")),
    cert: fs.readFileSync(path.join(certDir, "cert.pem")),
  },
  (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(POST);
  },
);
await new Promise((res, rej) => {
  server.once("error", rej);
  server.listen(HTTPS_PORT, "127.0.0.1", res);
});

for (let i = 0; ; i++) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`);
  } catch {
    break;
  }
  if (i === 19) {
    console.error(`порт ${PORT} занят другим браузером — закройте его и повторите`);
    process.exit(2);
  }
  await sleep(500);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tmc-handoff-"));
const browser = spawn(chromePath, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${HTTPS_PORT}`,
  "--ignore-certificate-errors",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--headless=new", // без окна: не отнимать фокус у приложений
  "--window-position=-3000,-3000",
  "--window-size=1000,800",
  "about:blank",
], { stdio: "ignore" });

let browserGone = null;
browser.once("exit", (code, signal) => {
  browserGone = `браузер завершился сам (code=${code}, signal=${signal})`;
});

const http = (p, init = {}) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, { ...init, signal: AbortSignal.timeout(15_000) });
const targets = async () => (await http("/json/list")).json();
const openTab = async (url) => (await http(`/json/new?${url}`, { method: "PUT" })).json();

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const drop = () => {
    for (const [n, res] of pending) {
      pending.delete(n);
      res({ result: { exceptionDetails: { text: "соединение с браузером потеряно" } } });
    }
  };
  ws.addEventListener("close", drop);
  ws.addEventListener("error", drop);
  return {
    ready,
    close: () => ws.close(),
    send: (method, params = {}) =>
      new Promise((res) => {
        if (ws.readyState !== WebSocket.OPEN) {
          res({ result: { exceptionDetails: { text: "соединение с браузером потеряно" } } });
          return;
        }
        const n = ++id;
        pending.set(n, res);
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
  };
}
// userGesture: клик и переход должны выглядеть как действие человека,
// иначе браузер может не пустить переход на внешнюю схему вовсе.
async function evaluate(client, expression) {
  const r = await client.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description ?? ex.text ?? "eval failed");
  return r.result?.result?.value;
}
async function attach(wsUrl) {
  const c = cdp(wsUrl);
  await c.ready;
  await c.send("Runtime.enable");
  return c;
}
const openUrls = async () =>
  (await targets()).filter((t) => t.type === "page").map((t) => t.url);

try {
  for (let i = 0; i < 40; i++) {
    try { await targets(); break; } catch { await sleep(500); }
  }

  // Включаем Telegram со страницы настроек, пока вкладок нет. Воркер MV3
  // ленивый и в списке целей появится, только когда его разбудит событие, —
  // его найдём после открытия вкладок.
  const options = await openTab(`chrome-extension://${extId}/options.html`);
  const oc = await attach(options.webSocketDebuggerUrl);
  await sleep(1000);
  await evaluate(oc, "chrome.storage.sync.set({enabled: {telegram: true}})");
  oc.close();

  const readUrl = `https://${HOST}/durov/100?mark=read`;
  const clickUrl = `https://${HOST}/durov/101?mark=click`;
  const jsUrl = `https://${HOST}/durov/102?mark=js`;
  const feedUrl = `https://${HOST}/s/durov?mark=feed`;

  await openTab(readUrl);
  const click = await openTab(clickUrl);
  const js = await openTab(jsUrl);
  const feed = await openTab(feedUrl);
  await sleep(3000);

  const cc = await attach(click.webSocketDebuggerUrl);
  check(
    (await evaluate(cc, "document.title")) === "Telegram: View @durov",
    "пост отдан по настоящему адресу t.me/…",
  );

  // Пятая вкладка делает остальные фоновыми
  await openTab("about:blank");
  await sleep(1500);

  let swTarget;
  for (let i = 0; i < 40 && !swTarget; i++) {
    swTarget = (await targets()).find((t) => t.type === "service_worker" && t.url.includes(extId));
    if (!swTarget) await sleep(500);
  }
  check(!!swTarget, "service worker тестовой копии расширения работает");
  const sw = await attach(swTarget.webSocketDebuggerUrl);

  const tabIdBy = async (mark) => evaluate(sw, `
    chrome.tabs.query({url: "https://${HOST}/*"})
      .then(ts => ts.find(t => t.url.includes("mark=${mark}"))?.id ?? null)`);
  const askPage = async (id) => JSON.parse(await evaluate(
    sw, `chrome.tabs.sendMessage(${id}, {type: "state"}).then(JSON.stringify)`));
  const alarmNames = async () => JSON.parse(await evaluate(
    sw, "chrome.alarms.getAll().then(a => JSON.stringify(a.map(x => x.name)))"));

  const readId = await tabIdBy("read");
  const clickId = await tabIdBy("click");
  check((await askPage(readId)).handedOff === false, "content script отвечает и докладывает handedOff=false до клика");
  check(
    !(await alarmNames()).some((n) => n.startsWith("close:")),
    "фоновые посты без клика отсчёта не получили",
  );

  // --- переход в приложение ---
  const jc = await attach(js.webSocketDebuggerUrl);
  const fc = await attach(feed.webSocketDebuggerUrl);
  await evaluate(cc, "document.getElementById('open').click()");
  await evaluate(jc, "location.href = 'mtc-test://resolve?domain=durov&post=102'");
  await evaluate(fc, "document.getElementById('open').click()");
  await sleep(1500);

  check((await askPage(clickId)).handedOff === true, "клик по ссылке на приложение: content script докладывает handedOff=true");
  check(
    (await evaluate(cc, "location.href")) === clickUrl,
    "…а сама страница никуда не ушла — переход забрал браузер",
  );
  const jsId = await tabIdBy("js");
  check((await askPage(jsId)).handedOff === true, "переход скриптом (location.href) ловится так же");
  const armed = await alarmNames();
  check(
    armed.includes(`close:${clickId}`) && armed.includes(`close:${jsId}`),
    "обе переданные вкладки получили отсчёт сразу, без тика",
  );

  console.log("      ждём отсчёт (~45 с)…");
  await sleep(45_000);

  const open = await openUrls();
  check(open.includes(readUrl), "пост, открытый почитать, НЕ закрыт");
  check(!open.includes(clickUrl), "вкладка после клика «Открыть в Telegram» закрыта");
  check(!open.includes(jsUrl), "вкладка после перехода скриптом закрыта");
  check(open.includes(feedUrl), "лента t.me/s/… НЕ закрыта, даже после клика");

  const closed = await evaluate(sw, "chrome.storage.local.get('closed').then(o => o.closed ?? 0)");
  check(closed === 2, `счётчик закрытых вкладок: ${closed} (ожидалось 2)`);

  sw.close(); cc.close(); jc.close(); fc.close();
} catch (e) {
  console.error("\nОШИБКА:", browserGone ? `${browserGone}; ${e.message}` : e.message);
  failures++;
} finally {
  if (browserGone && !failures) { console.error(`\nОШИБКА: ${browserGone}`); failures++; }
  browser.kill("SIGTERM");
  await sleep(400);
  try { browser.kill("SIGKILL"); } catch {}
  server.close();
  await new Promise((r) => { browser.once("exit", r); setTimeout(r, 3000); });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  fs.rmSync(certDir, { recursive: true, force: true });
  fs.rmSync(EXT, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
