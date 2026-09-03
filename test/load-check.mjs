// Проверка, что расширение реально загружается браузером: манифест валиден,
// локали подставляются, реестр приезжает через importScripts, service worker
// стартует без ошибок, страница настроек отрисовывается.
//
// Мок из smoke.mjs всего этого не видит — он выполняет background.js в Node,
// где нет ни манифеста, ни _locales, ни проверок стора.
//
// Запуск: node test/load-check.mjs
// Браузер берётся из CHROME= или ищется среди установленных.
//
// Две грабли, на которые здесь потрачено время:
//  - у браузера есть свои встроенные service worker'ы (Google Network Speech
//    и прочие компонентные расширения), и в /json/list они выглядят ровно как
//    наш; поэтому цель ищем по заранее вычисленному id;
//  - MV3-worker ленивый: пока его никто не позвал, в /json/list его нет
//    вообще. Будим сообщением со страницы настроек;
//  - Chrome с версии 137 выпилил --load-extension совсем (в 153 не помогает
//    и флаг DisableLoadExtensionCommandLineSwitch): расширение просто молча
//    не грузится, и в профиле пусто. Поэтому первым в списке Яндекс Браузер —
//    он и целевой браузер Антона, и единственный тут, который умеет грузить
//    распакованное расширение с командной строки. Headless тоже отпадает:
//    расширения в нём не поднимаются, окно уводим за пределы экрана.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(root, "extension");
const PORT = 9333;

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

// Для распакованного расширения Chrome выводит id из абсолютного пути:
// sha256(path), первые 16 байт, каждый полубайт → буква a..p.
const extId = [...crypto.createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 0xf])
  .map((n) => String.fromCharCode(97 + n))
  .join("");

let failures = 0;
const check = (cond, msg, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}${extra && !cond ? `\n      ${extra}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Порт отладки — общий ресурс. Если на нём уже висит браузер от прошлого
// прогона, свой не поднимется, а скрипт молча прицепится к чужому и выдаст
// бессмысленный результат. Ровно так и вышло однажды: поодиночке тест
// зелёный, в цепочке — три падения. Лучше громко отказаться.
for (let i = 0; ; i++) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`);
  } catch {
    break; // порт свободен — это нам и нужно
  }
  if (i === 19) {
    console.error(`порт ${PORT} занят другим браузером — закройте его и повторите`);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 500));
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tmc-load-"));
const browser = spawn(chromePath, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  // Окно живое, но за пределами экрана: расширения в headless не поднимаются,
  // а мигать окном посреди работы незачем.
  "--window-position=-3000,-3000",
  "--window-size=1000,800",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let stderr = "";
browser.stderr.on("data", (d) => { stderr += d; });
const extErrors = () =>
  stderr.split("\n").filter((l) => /extension|manifest/i.test(l)).slice(-6).join("\n");

// --- минимальный CDP-клиент ---
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  return {
    ready,
    close: () => ws.close(),
    send: (method, params = {}) =>
      new Promise((res) => {
        const n = ++id;
        pending.set(n, res);
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
  };
}

async function evaluate(client, expression) {
  const r = await client.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
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

try {
  // ждём, пока поднимется порт отладки
  for (let i = 0; i < 40; i++) {
    try { await targets(); break; } catch { await sleep(500); }
  }

  // --- страница настроек: она же доказывает, что манифест принят ---
  const created = await fetch(
    `http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/options.html`,
    { method: "PUT" },
  ).then((r) => r.json()).catch(() => null);
  check(!!created?.webSocketDebuggerUrl, `страница расширения открылась (id ${extId})`, extErrors());
  if (!created) throw new Error("расширение не загрузилось");

  await sleep(1500);
  const page = await attach(created.webSocketDebuggerUrl);

  const m = JSON.parse(await evaluate(page, "JSON.stringify(chrome.runtime.getManifest())"));
  check(m.manifest_version === 3, `манифест MV3, версия ${m.version}`);
  check(!m.name.includes("__MSG_"), `имя подставлено из локали: «${m.name}»`, m.name);
  check(!m.description.includes("__MSG_"), "описание подставлено из локали", m.description);
  check(!(m.permissions ?? []).includes("tabs"), "широкого разрешения tabs нет");

  const heading = await evaluate(page, "document.getElementById('t-title').textContent");
  check(heading?.length > 3, `страница настроек отрисовалась: «${heading}»`);
  const rows = await evaluate(
    page, "document.querySelectorAll('#ready li, #optional li').length");
  check(rows === 12, `в настройках ${rows} платформ (ожидалось 12)`);
  const groups = await evaluate(page, `JSON.stringify({
    ready: document.querySelectorAll('#ready li').length,
    optional: document.querySelectorAll('#optional li').length,
  })`);
  check(groups === '{"ready":5,"optional":7}', `платформы разложены по группам: ${groups}`);
  const asks = await evaluate(
    page, "document.querySelectorAll('#optional .badge.ask').length");
  check(asks === 7, `у ${asks} платформ помечено, что нужен доступ (ожидалось 7)`);
  const badges = await evaluate(
    page, "[...document.querySelectorAll('.badge')].map(b => b.textContent).join(' | ')");
  check(badges?.length > 5 && !badges.includes("undefined"), `метки проверки: ${badges}`);
  // Фавиконка обязательна на любой HTML-странице, и мало объявить ссылку —
  // data-URI должен ещё и разворачиваться в валидный SVG.
  const favicon = await evaluate(page, `(async () => {
    const link = document.querySelector('link[rel=icon]');
    if (!link?.href.startsWith('data:image/svg+xml')) return 'ссылки нет';
    const svg = await (await fetch(link.href)).text();
    return svg.startsWith('<svg') && svg.includes('</svg>') ? 'ok' : 'битый SVG';
  })()`);
  check(favicon === "ok", `фавиконка на месте и разворачивается в SVG (${favicon})`);

  const pageErrors = await evaluate(
    page, "String(window.__err ?? '')"); // options.js падений не логирует, но пусть будет
  check(!pageErrors, "страница настроек без исключений");

  // --- будим service worker и проверяем его ---
  await evaluate(page, "chrome.runtime.sendMessage({type:'page',state:{watched:true}}).catch(()=>{})");
  await sleep(1200);

  let swTarget;
  for (let i = 0; i < 20 && !swTarget; i++) {
    swTarget = (await targets()).find(
      (t) => t.type === "service_worker" && t.url.includes(extId));
    if (!swTarget) await sleep(500);
  }
  check(!!swTarget, "service worker стартовал", extErrors());
  if (swTarget) {
    const sw = await attach(swTarget.webSocketDebuggerUrl);
    const registry = await evaluate(
      sw, "typeof PLATFORMS !== 'undefined' ? PLATFORMS.map(p => p.id).join(',') : 'НЕТ'");
    check(registry !== "НЕТ", `importScripts подхватил реестр: ${registry}`);
    check(registry.split(",").length === 12, `в реестре ${registry.split(",").length} платформ (ожидалось 12)`);

    const alarmsOk = await evaluate(sw, "chrome.alarms.getAll().then(a => Array.isArray(a))");
    check(alarmsOk === true, "chrome.alarms доступен, worker живой");

    await evaluate(sw, "chrome.storage.sync.set({delaySeconds: 60})");
    const back = await evaluate(
      sw, "chrome.storage.sync.get('delaySeconds').then(o => o.delaySeconds)");
    check(back === 60, "настройки пишутся и читаются");

    // Важно и неочевидно: браузер выдаёт host-разрешения ПОХОСТНО, путь
    // в паттерне при выдаче игнорируется. Рядом с "https://*.zoom.us/j/*"
    // в списке оказывается "https://*.zoom.us/*". Узкие пути в манифесте
    // всё равно оставлены — они управляют content_scripts и документируют
    // намерение, — но обещать ревью «только эти адреса» нельзя.
    // Проверяем то, что реально важно: доступ ограничен нашими доменами
    // и ни одно разрешение не раздаёт весь интернет.
    const granted = JSON.parse(await evaluate(
      sw, "new Promise(r => chrome.permissions.getAll(p => r(JSON.stringify(p.origins))))"));
    const DOMAINS = ["yandex.ru", "zoom.us", "zoomgov.com", "microsoft.com", "live.com",
      "webex.com", "gotomeeting.com", "goto.com"];
    const stray = granted.filter((o) => {
      const host = o.replace(/^https?:\/\//, "").split("/")[0].replace(/^\*\./, "");
      return !DOMAINS.some((d) => host === d || host.endsWith("." + d));
    });
    check(stray.length === 0, `все ${granted.length} разрешений — на домены ВКС`, stray.join(", "));
    check(
      !granted.some((o) => /^https?:\/\/\*\/|<all_urls>/.test(o)),
      "нет разрешения на все сайты");

    // Главное свойство опциональных разрешений: при установке их НЕ выдают.
    // Если бы выдали, вся затея теряла бы смысл — предупреждение выросло бы
    // на девять доменов у каждого установившего.
    const optional = m.optional_host_permissions ?? [];
    check(optional.length === 9, `в манифесте ${optional.length} опциональных доменов`);
    const leaked = optional.filter((o) => {
      const host = o.replace(/^https?:\/\//, "").split("/")[0].replace(/^\*\./, "");
      return granted.some((g) => g.includes(host));
    });
    check(leaked.length === 0, "опциональные домены при установке не выданы", leaked.join(", "));
    sw.close();
  }
  page.close();
} catch (e) {
  console.error("\nОШИБКА:", e.message);
  if (stderr) console.error(extErrors());
  failures++;
} finally {
  browser.kill("SIGTERM");
  await sleep(400);
  try { browser.kill("SIGKILL"); } catch {}
  // Профиль убираем только после выхода процесса: пока браузер дописывает
  // его, rm получает ENOTEMPTY и роняет зелёный прогон на последней строке.
  await new Promise((r) => { browser.once("exit", r); setTimeout(r, 3000); });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
