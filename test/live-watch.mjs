// Живая проверка на НАСТОЯЩЕЙ встрече: показывает, что видит расширение,
// пока вы сами проходите путь пользователя — «Продолжить в браузере»,
// экран входа, зал ожидания, звонок, выход.
//
// Запуск: node test/live-watch.mjs <ссылка на встречу> [секунд, по умолчанию 240]
//
// Откроется окно Яндекс Браузера с загруженным расширением и вашей ссылкой.
// Дальше — руками: нажать «Продолжить в браузере», разрешить камеру,
// войти во встречу, уйти в другое приложение (⌘Tab), вернуться, выйти
// из встречи, снова уйти. Скрипт раз в 3 секунды печатает строку:
//
//   t=12s  active=✓ focused=✗ audible=✗ | call=1 capture=2 media=3 | watched=✗ busy=✓ | alarm=✓
//
// call     — живых WebRTC-соединений (датчик rtc-probe.js)
// capture  — дорожек камеры/микрофона/экрана, которые держит страница
// media    — играющих <video>/<audio>
// watched  — страница считает, что на неё смотрят
// busy     — страница говорит «не закрывай»
// alarm    — отсчёт до закрытия взведён
//
// Ожидания: пока вы во встрече или на экране входа — busy=✓ и вкладка жива,
// сколько бы вы ни отсутствовали. После выхода из встречи — busy=✗ и через
// заданную задержку строка «ВКЛАДКА ЗАКРЫТА». Профиль временный: логина
// в Яндексе в этом окне не будет, войти можно гостем.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [url, secondsArg] = process.argv.slice(2);
if (!url || !/^https?:\/\//.test(url)) {
  console.error("использование: node test/live-watch.mjs <https://…ссылка на встречу> [секунд]");
  process.exit(2);
}
const totalSeconds = Number(secondsArg) || 240;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(root, "extension");
const PORT = 9335;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await fetch(`http://127.0.0.1:${PORT}/json/version`);
  console.error(`порт ${PORT} занят другим браузером — закройте его и повторите`);
  process.exit(2);
} catch {
  // свободен
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tmc-watch-"));
const browser = spawn(chromePath, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1200,800",
  url,
], { stdio: "ignore" });

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

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
  const r = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
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

const mark = (v) => (v ? "✓" : "✗");
const origin = new URL(url).origin;

try {
  for (let i = 0; i < 40; i++) {
    try { await targets(); break; } catch { await sleep(500); }
  }

  // Будим service worker со страницы настроек и держим её открытой в фоне.
  const opts = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/options.html`, { method: "PUT" },
  )).json();
  await sleep(1500);
  // Вернуть фокус вкладке со встречей.
  await fetch(`http://127.0.0.1:${PORT}/json/activate/${(await targets()).find((t) => t.url.startsWith(origin))?.id}`);

  let swTarget;
  for (let i = 0; i < 20 && !swTarget; i++) {
    swTarget = (await targets()).find((t) => t.type === "service_worker" && t.url.includes(extId));
    if (!swTarget) await sleep(500);
  }
  if (!swTarget) throw new Error("service worker расширения не поднялся");
  const sw = await attach(swTarget.webSocketDebuggerUrl);

  console.log(`\nОткрыта ${url}\nДальше руками: «Продолжить в браузере» → войти → уйти в другое приложение → вернуться → выйти → уйти.\n`);

  const started = Date.now();
  let closedBefore = await evaluate(sw, "chrome.storage.local.get('closed').then(o => o.closed ?? 0)");
  let page = null;
  let lastPageUrl = null;

  while (Date.now() - started < totalSeconds * 1000) {
    const t = Math.round((Date.now() - started) / 1000);
    const info = JSON.parse(await evaluate(sw, `(async () => {
      const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(origin + "/*")} });
      if (!tab) return JSON.stringify({ gone: true });
      const win = await chrome.windows.get(tab.windowId).catch(() => ({ focused: false }));
      const alarm = await chrome.alarms.get("close:" + tab.id);
      const state = await chrome.tabs.sendMessage(tab.id, { type: "state" }).catch(() => null);
      return JSON.stringify({ id: tab.id, url: tab.url, active: tab.active, focused: win.focused,
        audible: !!tab.audible, alarm: !!alarm, state });
    })()`));

    if (info.gone) {
      const closedNow = await evaluate(sw, "chrome.storage.local.get('closed').then(o => o.closed ?? 0)");
      console.log(`t=${t}s  ВКЛАДКА ЗАКРЫТА ${closedNow > closedBefore ? "расширением (счётчик вырос)" : "(не расширением: счётчик не вырос)"}`);
      break;
    }

    // Атрибуты датчика читаем прямо со страницы (page target).
    let probe = "call=? capture=? media=?";
    try {
      const pt = (await targets()).find((x) => x.type === "page" && x.url === info.url);
      if (pt && (!page || lastPageUrl !== info.url)) {
        page?.close();
        page = await attach(pt.webSocketDebuggerUrl);
        lastPageUrl = info.url;
      }
      if (page) {
        const p = JSON.parse(await evaluate(page, `JSON.stringify({
          call: document.documentElement.getAttribute('data-mtc-call') ?? 0,
          capture: document.documentElement.getAttribute('data-mtc-capture') ?? 0,
          media: [...document.querySelectorAll('video,audio')].filter(e => !e.paused && !e.ended && e.readyState > 2).length,
          frames: document.querySelectorAll('iframe').length,
        })`));
        probe = `call=${p.call} capture=${p.capture} media=${p.media} frames=${p.frames}`;
      }
    } catch {
      page = null;
    }

    const s = info.state;
    console.log(
      `t=${String(t).padStart(3)}s  active=${mark(info.active)} focused=${mark(info.focused)} audible=${mark(info.audible)} | ${probe} | ` +
      (s ? `watched=${mark(s.watched)} busy=${mark(s.busy)}` : "страница не отвечает (скрипт не внедрён?)") +
      ` | alarm=${mark(info.alarm)}  ${info.url.replace(origin, "")}`,
    );
    await sleep(3000);
  }

  sw.close(); page?.close();
} catch (e) {
  console.error("\nОШИБКА:", e.message);
} finally {
  console.log("\nЗакрываю браузер.");
  browser.kill("SIGTERM");
  await new Promise((r) => { browser.once("exit", r); setTimeout(r, 3000); });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
