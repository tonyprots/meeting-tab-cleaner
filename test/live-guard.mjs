// Живой сквозной прогон в настоящем браузере с загруженным расширением.
// Проверяет то, что мок проверить не может по определению: реально ли
// внедряются оба content script'а, реально ли service worker закрывает
// вкладку и реально ли работают обе защиты «здесь идёт звонок».
//
// Как устроено: поднимаем локальный HTTPS-сервер с самоподписанным
// сертификатом и подменяем браузеру DNS (--host-resolver-rules), чтобы
// настоящий адрес telemost.360.yandex.ru/j/... вёл на него. Только так URL
// совпадёт с манифестом и расширение вообще увидит страницу.
//
// Пять вкладок — по одной на каждое состояние.
//
// Адрес посредника (telemost/j/…):
//   plain — пустая страница, обязана закрыться;
//   media — играющий <video>, обязана выжить;
//   rtc   — живое WebRTC-соединение и НИ ОДНОГО медиаэлемента; выжить она
//           может только за счёт rtc-probe.js. Потом соединение закрывается,
//           и вкладка обязана закрыться.
//
// Адрес звонка (zoom.us/wc/…), где правило ровно то же самое:
//   session-call — звонок идёт → выжить; после выхода → закрыться;
//   session-idle — звонка не было → закрыться сразу, как и любой хвост.
//
// Ещё одна вкладка делает остальные фоновыми, поэтому «пользователь на них
// не смотрит» выполняется независимо от того, в фокусе ли окно браузера.
//
// Запуск: node test/live-guard.mjs   (≈2 минуты, окно уводится за экран)

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(root, "extension");
const PORT = 9334;
const HTTPS_PORT = 8443;
const HOST = "telemost.360.yandex.ru";
// Вторая площадка — session-платформа: адрес приглашения и есть адрес звонка.
// Взят zoom-web, потому что разрешение на домен обязательное, и в тест
// не нужно тащить выдачу опциональных разрешений.
const SESSION_HOST = "zoom.us";

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

const extId = [...crypto.createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 0xf])
  .map((n) => String.fromCharCode(97 + n))
  .join("");

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- локальный HTTPS вместо Телемоста ---
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmc-cert-"));
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", path.join(certDir, "key.pem"),
  "-out", path.join(certDir, "cert.pem"),
  "-days", "1", "-subj", `/CN=${HOST}`,
], { stdio: "ignore" });

const PLAIN = "<!doctype html><meta charset=utf-8><title>Посредник</title><p>Открываем приложение…";

// Играющее видео из потока canvas — то же самое, чем в живом звонке является
// превью собственной камеры: <video srcObject=MediaStream>.
const MEDIA = `<!doctype html><meta charset=utf-8><title>Звонок со звуком</title>
<canvas id=c width=64 height=48></canvas><video id=v muted playsinline></video>
<script>
  const ctx = c.getContext('2d');
  setInterval(() => { ctx.fillStyle = '#' + ((Date.now() / 100 | 0) % 999); ctx.fillRect(0, 0, 64, 48); }, 100);
  v.srcObject = c.captureStream(10);
  v.play();
</script>`;

// Страница «звонок идёт прямо в браузере». Медиаэлементов на ней нет
// НАМЕРЕННО — так вкладку может держать только датчик WebRTC.
//
// Настоящий RTCPeerConnection здесь создаётся (это проверяет, что обёртка
// встала и прозрачна), но до `connected` он не доходит: в песочнице, где
// гоняются тесты, UDP между сокетами не проходит, ICE застревает на
// `checking`. Поэтому состояние `connected` подаётся тест-дублем — своим
// геттером `connectionState` плюс настоящее событие `connectionstatechange`.
// Это ровно тот контракт, на который подписан датчик; что событие шлёт сам
// браузер — гарантия платформы, а не наш код. Полный путь с живой сетью
// проверяется одним реальным звонком, см. store/README.md.
const RTC = `<!doctype html><meta charset=utf-8><title>Звонок в браузере</title>
<p id=s>…
<script>
  window.__state = 'init';
  const pc = new RTCPeerConnection();
  window.__pc = pc;

  const say = (state) => {
    Object.defineProperty(pc, 'connectionState', { value: state, configurable: true });
    window.__state = state;
    s.textContent = state;
    pc.dispatchEvent(new Event('connectionstatechange'));
  };

  window.__join = () => say('connected');
  window.__hangup = () => { pc.close(); window.__state = 'hungup'; };
</script>`;

// Экран входа / зал ожидания: страница держит микрофон, но соединения ещё
// нет и ни одного медиаэлемента тоже. Удержать её может только признак
// захвата. Микрофон отдаётся браузером-подделкой (--use-fake-device…).
const CAPTURE = `<!doctype html><meta charset=utf-8><title>Зал ожидания</title>
<p id=s>…
<script>
  window.__stream = null;
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((st) => { window.__stream = st; s.textContent = 'captured'; })
    .catch((e) => { s.textContent = 'error ' + e.name; });
  window.__release = () => window.__stream.getTracks().forEach((t) => t.stop());
</script>`;

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(certDir, "key.pem")),
    cert: fs.readFileSync(path.join(certDir, "cert.pem")),
  },
  (req, res) => {
    const body = req.url.includes("media") ? MEDIA
      : req.url.includes("rtc") ? RTC
      : req.url.includes("capture") ? CAPTURE
      : PLAIN;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  },
);
await new Promise((res, rej) => {
  server.once("error", rej);
  server.listen(HTTPS_PORT, "127.0.0.1", res);
});
const trace = (msg) => process.env.TRACE && console.error(`… ${msg}`);
trace(`https-заглушка на ${HTTPS_PORT}`);

// Тот же общий ресурс, что и в load-check.mjs: занятый порт отладки уводит
// скрипт к чужому браузеру, и результат становится ложью.
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
  await new Promise((r) => setTimeout(r, 500));
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tmc-guard-"));
const browser = spawn(chromePath, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${HTTPS_PORT},MAP ${SESSION_HOST} 127.0.0.1:${HTTPS_PORT}`,
  "--ignore-certificate-errors",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--window-position=-3000,-3000",
  "--window-size=1000,800",
  "about:blank",
], { stdio: "ignore" });

let browserGone = null;
browser.once("exit", (code, signal) => {
  browserGone = `браузер завершился сам (code=${code}, signal=${signal})`;
});

// Таймаут на каждый HTTP-запрос к порту отладки: без него смерть браузера
// посреди прогона превращается в вечное ожидание.
const http = (path, init = {}) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
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
  // Упавший браузер (или закрытая им вкладка) не отвечает никогда — без
  // этого тест повисал бы молча вместо FAIL.
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
const openUrls = async () =>
  (await targets()).filter((t) => t.type === "page").map((t) => t.url);

try {
  trace("браузер запущен, ждём порт отладки");
  for (let i = 0; i < 40; i++) {
    try { await targets(); break; } catch { await sleep(500); }
  }
  trace("порт отладки отвечает, открываем вкладки");

  const plainUrl = `https://${HOST}/j/plain-1`;
  const mediaUrl = `https://${HOST}/j/media-1`;
  const rtcUrl = `https://${HOST}/j/rtc-1`;
  // session: одна вкладка со звонком, одна — где звонка не было никогда
  // Путь как у настоящего веб-клиента: /wc/<id>/join. Голый /wc/<имя> гейт
  // больше не пропускает — под него попадала домашняя страница /wc/home.
  const sessionCallUrl = `https://${SESSION_HOST}/wc/9002/join?mark=rtc-2`;
  const sessionIdleUrl = `https://${SESSION_HOST}/wc/9001/join?mark=plain-2`;

  const captureUrl = `https://${HOST}/j/capture-1`;

  const plain = await openTab(plainUrl);
  const media = await openTab(mediaUrl);
  const rtc = await openTab(rtcUrl);
  const sessionCall = await openTab(sessionCallUrl);
  await openTab(sessionIdleUrl);
  const capture = await openTab(captureUrl);
  trace("шесть вкладок открыты, ждём загрузки");
  await sleep(3000);

  const cc = await attach(capture.webSocketDebuggerUrl);
  check(
    (await evaluate(cc, "document.getElementById('s').textContent")) === "captured",
    "во вкладке capture страница получила микрофон",
  );
  check(
    await evaluate(cc, "document.querySelectorAll('video, audio').length === 0 && !document.documentElement.hasAttribute('data-mtc-call')"),
    "…и ни медиаэлемента, ни соединения в ней нет — держать может только признак захвата",
  );

  const pc = await attach(plain.webSocketDebuggerUrl);
  check(
    (await evaluate(pc, "document.title")) === "Посредник",
    "страница-посредник отдана по настоящему адресу telemost.360.yandex.ru/j/…",
  );

  const mc = await attach(media.webSocketDebuggerUrl);
  check(
    await evaluate(mc, "(() => { const v = document.querySelector('video'); return !v.paused && v.readyState > 2; })()"),
    "во вкладке media действительно играет медиа",
  );

  // --- датчик WebRTC ---
  const rc = await attach(rtc.webSocketDebuggerUrl);
  check(
    await evaluate(rc, "document.querySelectorAll('video, audio').length === 0"),
    "во вкладке rtc нет ни одного медиаэлемента — держать её может только датчик WebRTC",
  );
  check(
    await evaluate(rc, "window.__pc instanceof RTCPeerConnection && RTCPeerConnection.name === 'RTCPeerConnection'"),
    "подмена RTCPeerConnection прозрачна для страницы (instanceof и имя конструктора на месте)",
  );
  check(
    !(await evaluate(rc, "document.documentElement.hasAttribute('data-mtc-call')")),
    "созданный, но не подключённый RTCPeerConnection звонком НЕ считается",
  );

  await evaluate(rc, "window.__join()");
  await sleep(300);
  check(
    await evaluate(rc, "document.documentElement.hasAttribute('data-mtc-call')"),
    "переход в connected датчик отметил как живой звонок",
  );

  const sc = await attach(sessionCall.webSocketDebuggerUrl);
  await evaluate(sc, "window.__join()");
  await sleep(300);

  // Четвёртая вкладка делает предыдущие фоновыми
  await openTab("about:blank");
  await sleep(1000);

  let swTarget;
  for (let i = 0; i < 20 && !swTarget; i++) {
    swTarget = (await targets()).find((t) => t.type === "service_worker" && t.url.includes(extId));
    if (!swTarget) await sleep(500);
  }
  check(!!swTarget, "service worker расширения работает");
  const sw = await attach(swTarget.webSocketDebuggerUrl);

  const armed = JSON.parse(await evaluate(
    sw, "chrome.alarms.getAll().then(a => JSON.stringify(a.map(x => x.name)))"));
  check(
    armed.filter((n) => n.startsWith("close:")).length === 6,
    `отсчёт взведён для всех шести вкладок — правило одно на всех (${armed.length} алармов)`,
  );

  const tabIdBy = async (mark) => evaluate(sw, `
    chrome.tabs.query({url: "https://${HOST}/j/*"})
      .then(ts => ts.find(t => t.url.includes("${mark}"))?.id ?? null)`);
  const rtcTabId = await tabIdBy("rtc");
  const askPage = async (id) => JSON.parse(await evaluate(
    sw, `chrome.tabs.sendMessage(${id}, {type: "state"}).then(JSON.stringify)`));

  const rtcState = await askPage(rtcTabId);
  check(rtcState.busy === true, "content script докладывает busy=true по сигналу WebRTC");
  check(rtcState.watched === false, "он же докладывает watched=false для фоновой вкладки");
  const captureTabId = await tabIdBy("capture");
  check((await askPage(captureTabId)).busy === true, "content script докладывает busy=true по захвату микрофона");

  // --- ждём первого срабатывания ---
  console.log("      ждём отсчёт (~45 с)…");
  await sleep(45_000);

  let open = await openUrls();
  check(!open.includes(plainUrl), "пустая вкладка-посредник закрыта");
  check(open.includes(mediaUrl), "вкладка с играющим медиа НЕ закрыта");
  check(open.includes(rtcUrl), "вкладка с живым WebRTC НЕ закрыта");
  check(open.includes(sessionCallUrl), "адрес звонка: вкладка с идущим звонком НЕ закрыта");
  check(
    !open.includes(sessionIdleUrl),
    "адрес звонка: тихая вкладка закрыта так же, как любой хвост",
  );
  check(open.includes(captureUrl), "вкладка, держащая микрофон (зал ожидания), НЕ закрыта");

  // --- выход из встречи ---
  await evaluate(rc, "window.__hangup()");
  await evaluate(sc, "window.__hangup()");
  await evaluate(cc, "window.__release()");
  await sleep(1000);
  check((await askPage(captureTabId)).busy === false, "после отпускания микрофона страница докладывает busy=false");
  check(
    !(await evaluate(rc, "document.documentElement.hasAttribute('data-mtc-call')")),
    "после выхода из звонка датчик снял отметку",
  );
  check((await askPage(rtcTabId)).busy === false, "content script докладывает busy=false");

  console.log("      ждём отсчёт после выхода из звонка (~45 с)…");
  await sleep(45_000);

  open = await openUrls();
  check(!open.includes(rtcUrl), "вкладка закрыта после того, как звонок завершился");
  check(!open.includes(sessionCallUrl), "адрес звонка: вкладка закрыта после выхода из встречи");
  check(open.includes(mediaUrl), "вкладка с медиа по-прежнему жива");
  check(!open.includes(captureUrl), "вкладка закрыта после того, как микрофон отпущен");

  const closed = await evaluate(sw, "chrome.storage.local.get('closed').then(o => o.closed ?? 0)");
  check(closed === 5, `счётчик закрытых вкладок: ${closed} (ожидалось 5)`);

  sw.close(); pc.close(); mc.close(); rc.close(); sc.close(); cc.close();
} catch (e) {
  console.error("\nОШИБКА:", browserGone ? `${browserGone}; ${e.message}` : e.message);
  failures++;
} finally {
  if (browserGone && !failures) { console.error(`\nОШИБКА: ${browserGone}`); failures++; }
  browser.kill("SIGTERM");
  await sleep(400);
  try { browser.kill("SIGKILL"); } catch {}
  server.close();
  // Та же гонка, что в load-check: rm профиля до выхода процесса — ENOTEMPTY.
  await new Promise((r) => { browser.once("exit", r); setTimeout(r, 3000); });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  fs.rmSync(certDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
