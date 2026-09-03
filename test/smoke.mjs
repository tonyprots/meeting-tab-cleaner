// Смоук-тест логики background.js на моке chrome-API.
// Запуск: node test/smoke.mjs (из корня проекта).
//
// Мок событий не ловит класс багов «браузер не прислал событие» — ради него
// существует test/live-guard.mjs и живой прогон. Зато здесь дёшево проверяются
// три вещи, которые вживую проверять больно: реестр платформ, цепочка защит
// и то, что манифест не разъехался с platforms.js.

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(root, p), "utf8");

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

// --- match-паттерны: та же семантика, что у браузера ---
// Нужны и моку tabs.query, и проверке манифеста. Пишем свой конвертер, потому
// что именно паттерны решают, увидит ли расширение вкладку вообще.
const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
function patternToRegex(pattern) {
  const m = /^(\*|https?):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) throw new Error(`битый match-паттерн: ${pattern}`);
  const [, scheme, host, urlPath] = m;
  const schemeRe = scheme === "*" ? "https?" : scheme;
  const hostRe =
    host === "*"
      ? "[^/]+"
      : host.startsWith("*.")
        ? `(?:[^/.]+\\.)*${esc(host.slice(2))}`
        : esc(host);
  const pathRe = urlPath.split("*").map(esc).join(".*");
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
}

// --- мок chrome ---
const alarms = new Map();
const tabs = new Map();
const windows = new Map();
const pages = new Map(); // tabId -> ответ content script (или undefined = скрипта нет)
const store = { sync: {}, local: {} };
const grantedOrigins = new Set(); // выданные опциональные разрешения
const registered = []; // динамически зарегистрированные content scripts
const injected = []; // executeScript в уже открытые вкладки
const removed = [];
const listeners = {
  alarm: [], created: [], updated: [], removedTab: [],
  activated: [], focus: [], startup: [], installed: [], message: [], storage: [],
  permAdded: [], permRemoved: [],
};
const on = (arr) => ({ addListener: (f) => arr.push(f) });
const emit = async (arr, ...args) => { for (const f of arr) await f(...args); };

const storageArea = (name) => ({
  get: async (keys) => {
    const out = {};
    for (const key of [keys].flat()) if (key in store[name]) out[key] = store[name][key];
    return out;
  },
  set: async (obj) => {
    Object.assign(store[name], obj);
    await emit(listeners.storage, obj, name);
  },
});

const chrome = {
  alarms: {
    clear: async (name) => alarms.delete(name),
    get: async (name) => alarms.get(name),
    create: (name, info) => alarms.set(name, { name, ...info }),
    onAlarm: on(listeners.alarm),
  },
  tabs: {
    get: async (id) => {
      if (!tabs.has(id)) throw new Error("no tab");
      return tabs.get(id);
    },
    query: async ({ url }) => {
      const res = url.map(patternToRegex);
      return [...tabs.values()].filter((t) => res.some((re) => re.test(t.url ?? "")));
    },
    remove: async (id) => { tabs.delete(id); removed.push(id); },
    sendMessage: async (id) => {
      if (!pages.has(id)) throw new Error("no receiving end");
      return pages.get(id);
    },
    onCreated: on(listeners.created),
    onUpdated: on(listeners.updated),
    onRemoved: on(listeners.removedTab),
    onActivated: on(listeners.activated),
  },
  windows: {
    get: async (id) => {
      if (!windows.has(id)) throw new Error("no window");
      return windows.get(id);
    },
    onFocusChanged: on(listeners.focus),
  },
  storage: {
    sync: storageArea("sync"),
    local: storageArea("local"),
    onChanged: on(listeners.storage),
  },
  runtime: {
    onStartup: on(listeners.startup),
    onInstalled: on(listeners.installed),
    onMessage: on(listeners.message),
  },
  permissions: {
    contains: async ({ origins }) => origins.every((o) => grantedOrigins.has(o)),
    request: async ({ origins }) => { origins.forEach((o) => grantedOrigins.add(o)); return true; },
    remove: async ({ origins }) => { origins.forEach((o) => grantedOrigins.delete(o)); return true; },
    onAdded: on(listeners.permAdded),
    onRemoved: on(listeners.permRemoved),
  },
  scripting: {
    registerContentScripts: async (scripts) => { registered.push(...scripts); },
    unregisterContentScripts: async () => {
      if (!registered.length) throw new Error("no registered scripts");
      registered.length = 0;
    },
    executeScript: async (injection) => {
      if (!tabs.has(injection.target.tabId)) throw new Error("no tab");
      injected.push(injection);
    },
  },
};

// background.js обращается к chrome как к глобалу и вешает слушатели прямо
// при загрузке — мок должен существовать до выполнения. platforms.js в браузере
// приезжает через importScripts, здесь — просто выполняется раньше.
globalThis.chrome = chrome;
vm.runInThisContext(read("extension/platforms.js"), { filename: "platforms.js" });
vm.runInThisContext(read("extension/background.js"), { filename: "background.js" });

// --- хелперы ---
const fireAlarm = async (name) => {
  const a = alarms.get(name);
  if (!a) throw new Error(`alarm ${name} not armed`);
  // chrome удаляет одноразовый аларм при срабатывании, периодический — нет
  if (a.periodInMinutes === undefined) alarms.delete(name);
  await emit(listeners.alarm, a);
};
// onMessage-обработчик синхронный, а работу делает асинхронно — даём ей
// дойти до конца перед проверкой
const settle = () => new Promise((r) => setTimeout(r, 0));
const setSync = async (obj) => { await chrome.storage.sync.set(obj); };
const reset = async () => {
  alarms.clear(); tabs.clear(); windows.clear(); pages.clear(); removed.length = 0;
  store.sync = {}; store.local = {};
  grantedOrigins.clear(); registered.length = 0; injected.length = 0;
  await emit(listeners.storage, {}, "sync"); // сбросить кэш настроек в background
  await settle(); // смена настроек запускает reconcileAll — дать ему отработать на пустом
};
const tab = (id, url, extra = {}) => {
  const t = { id, url, windowId: 1, active: false, audible: false, pinned: false, ...extra };
  tabs.set(id, t);
  return t;
};

const J360 = "https://telemost.360.yandex.ru/j/1454583434";
const J = "https://telemost.yandex.ru/j/777";

// ============ реестр платформ ============

console.log("\n— реестр платформ —");

// Адреса, на которых вкладка ОКАЗЫВАЕТСЯ (не обязательно те, что
// в приглашении: Teams и Webex редиректят на лаунчер с другим путём) и
// которые обязаны попасть под гейт.
const WATCHED = {
  telemost: ["https://telemost.yandex.ru/j/777", "https://telemost.360.yandex.ru/j/abc-def"],
  zoom: [
    "https://zoom.us/j/93312345678?pwd=abc",
    "https://acme.zoom.us/j/93312345678",
    "https://acme.zoom.us/s/93312345678",
    "https://agency.zoomgov.com/j/1601234567",
    // веб-клиент — та же платформа и то же правило
    "https://zoom.us/wc/join/93312345678",
    "https://acme.zoom.us/wc/93312345678/join",
    "https://app.zoom.us/wc/93312345678/start",
    "https://app.zoom.us/wc/leave?reason=1",
  ],
  teams: [
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d",
    "https://teams.microsoft.com/meet/1234567890?p=Hashed",
    "https://teams.live.com/meet/9312345678901?p=Hashed",
    // …а вот куда они редиректят на самом деле (curl -L, 2026-09-04)
    "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_abc%40thread.v2%2F0&type=meetup-join&deeplinkId=3dcf&directDl=true&msLaunch=true&enableMobilePage=true",
    "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F2345678901234%3Fp%3Dabc&type=meet&deeplinkId=2515",
    "https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F9312345678901&type=meet",
  ],
  webex: [
    "https://acme.webex.com/acme/j.php?MTID=m9141c5525bf883b31f2c716b95f83a8c",
    "https://acme.webex.com/webappng/sites/acme/meeting/download/1a2b3c4d?siteurl=acme&MTID=m9141",
    "https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/download/1a2b3c4d?siteurl=acme",
  ],
  goto: [
    "https://global.gotomeeting.com/join/123456789",
    "https://app.goto.com/join/987654321",
    "https://meet.goto.com/123456789",
    "https://meet.goto.com/anton-room",
  ],
  meet: [
    "https://meet.google.com/abc-defg-hij",
    "https://meet.google.com/abc-defg-hij?authuser=1&hs=122",
    "https://meet.google.com/_meet/abc-defg-hij",
    "https://meet.google.com/lookup/team-sync",
  ],
  ktalk: ["https://acme.ktalk.ru/room-42", "https://kontur.ktalk.ru/11111"],
  mtslink: [
    "https://my.mts-link.ru/j/12345678/9876",
    "https://my.mts-link.ru/j/MTC/22879479831",
    "https://events.mts-link.ru/MTC/22879479831",
    "https://events.webinar.ru/12345/678",
  ],
  jazz: ["https://jazz.sber.ru/abc-def?psw=xyz", "https://jazz.sber.ru/#/calls/t2tc3p?psw=x"],
  jitsi: ["https://meet.jit.si/SomeRoom", "https://8x8.vc/vpaas-magic/SomeRoom"],
  whereby: ["https://whereby.com/my-room", "https://acme.whereby.com/standup"],
  chime: ["https://app.chime.aws/meetings/1234567890", "https://app.chime.aws/meetings/anton-personal-room"],
};

// Не комнаты на тех же доменах: корни, списки встреч, личные кабинеты,
// домашние страницы веб-приложений, сайт компании. Match-паттерн «путь
// непустой» или «только комнаты» выразить не умеет, поэтому такие адреса
// расширение видит — и обязано отсечь гейтом. Закрыть любой из них — баг.
const ROOTS = [
  "https://meet.google.com/",
  "https://meet.google.com",
  "https://meet.google.com/landing",
  "https://meet.google.com/landing?authuser=0",
  "https://meet.google.com/new",
  "https://meet.google.com/calendar",
  "https://app.zoom.us/wc/home",
  "https://app.zoom.us/wc/calendar",
  "https://acme.ktalk.ru/",
  "https://my.mts-link.ru/",
  "https://my.mts-link.ru/events",
  "https://my.mts-link.ru/organization/123/settings",
  "https://jazz.sber.ru/",
  "https://meet.jit.si/",
  "https://whereby.com/",
  "https://whereby.com/information/pricing",
  "https://whereby.com/blog/some-post",
  "https://whereby.com/user/login",
  "https://docs.whereby.com/reference",
  "https://app.chime.aws/",
  "https://app.chime.aws/meetings",
  "https://app.chime.aws/conversations/new?email=x%40y.z",
  "https://meet.goto.com/",
  "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fchat%2F0%2F0&type=chat&deeplinkId=1",
  "https://acme.webex.com/webappng/sites/acme/dashboard/home",
  "https://telemost.yandex.ru/",
];

// А эти расширение не должно видеть вообще — ни гейтом, ни паттерном.
const FOREIGN = [
  // Teams в браузере — целое рабочее пространство, а не одна встреча
  "https://teams.microsoft.com/v2/?meetingjoin=true",
  // веб-приложения, до которых мы сознательно не дотягиваемся
  "https://acme.webex.com/webappng/sites/acme/meeting/info/123",
  "https://app.goto.com/meeting/123456789",
  // VK Звонки исключены: доступ к vk.com выдаётся на весь сайт
  "https://vk.com/call/join/abcdef",
  // просто посторонние
  "https://ya.ru/j/123",
  // подделки под наши домены
  "https://telemost.yandex.ru.evil.com/j/1",
  "https://zoom.us.evil.com/j/93312345678",
  "https://webex.com.evil.com/x/j.php?MTID=1",
  "https://meet.google.com.evil.com/abc-defg-hij",
  "https://ktalk.ru.evil.com/room-42",
  "https://app.chime.aws.evil.com/meetings/1",
];

const allMatchRes = ALL_MATCHES.map(patternToRegex);
const patternHits = (url) => allMatchRes.some((re) => re.test(url));
const gateHits = (url) => PLATFORMS.some((p) => p.test.test(url));

for (const [id, urls] of Object.entries(WATCHED)) {
  const platform = PLATFORMS.find((p) => p.id === id);
  check(!!platform, `реестр: платформа ${id} существует`);
  if (!platform) continue;
  check(urls.every((u) => platform.test.test(u)), `реестр: ${id} — регулярка ловит все адреса`);
  check(urls.every(patternHits), `реестр: ${id} — match-паттерны ловят все адреса`);
  // Каждый адрес должен опознаваться ровно одной платформой, иначе порядок
  // записей в реестре начинает молча влиять на поведение.
  check(
    urls.every((u) => PLATFORMS.filter((p) => p.test.test(u)).length === 1),
    `реестр: ${id} — адреса не пересекаются с другими платформами`,
  );
}

check(
  PLATFORMS.filter((p) => p.optional).every((p) => !p.defaultOn),
  "реестр: платформы с опциональным доступом выключены по умолчанию",
);
check(
  Object.keys(WATCHED).length === PLATFORMS.length,
  `реестр: в тесте перечислены все ${PLATFORMS.length} платформ (${Object.keys(WATCHED).length})`,
);

check(
  FOREIGN.every((u) => !gateHits(u)),
  "реестр: чужие ВКС и подделки доменов не проходят гейт",
);
check(
  FOREIGN.every((u) => !patternHits(u)),
  "реестр: они же не проходят и match-паттерны — расширение их не увидит вовсе",
);
check(
  ROOTS.every((u) => !gateHits(u)),
  "реестр: корни доменов гейт не проходят",
);

// Манифест — третья копия тех же паттернов, и разъехаться она может молча.
const manifest = JSON.parse(read("extension/manifest.json"));
const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
check(
  sameSet(manifest.host_permissions, REQUIRED_MATCHES),
  "манифест: host_permissions совпадают с обязательной частью реестра",
);
check(
  sameSet(manifest.optional_host_permissions, OPTIONAL_MATCHES),
  "манифест: optional_host_permissions совпадают с опциональной частью реестра",
);
// Статические content_scripts объявляются только на обязательные домены:
// на опциональные браузер всё равно не станет внедрять скрипт, пока
// пользователь не выдал доступ, — их регистрирует background.js.
check(
  manifest.content_scripts.every((cs) => sameSet(cs.matches, REQUIRED_MATCHES)),
  `манифест: matches всех ${manifest.content_scripts.length} content_scripts — обязательная часть реестра`,
);
check(
  OPTIONAL_MATCHES.every((m) => !manifest.host_permissions.includes(m)),
  "манифест: опциональные домены не просятся при установке",
);
check(
  (manifest.permissions ?? []).includes("scripting"),
  "манифест: есть scripting — без него не зарегистрировать скрипты по требованию",
);
// Датчик WebRTC обязан жить в MAIN world и стартовать до скриптов страницы,
// иначе он не успеет подменить RTCPeerConnection и молча ничего не увидит.
const probe = manifest.content_scripts.find((cs) => cs.js.includes("rtc-probe.js"));
check(
  probe?.world === "MAIN" && probe.run_at === "document_start",
  `манифест: rtc-probe.js в MAIN world на document_start (world=${probe?.world}, run_at=${probe?.run_at})`,
);
check(
  manifest.content_scripts.find((cs) => cs.js.includes("content.js"))?.world === undefined,
  "манифест: content.js остаётся в изолированном мире (у него есть chrome-API)",
);
check(
  !(manifest.permissions ?? []).includes("tabs"),
  "манифест: широкого разрешения tabs нет (только host-разрешения)",
);
// world: "MAIN" в статических content_scripts понимает Chrome 111+; на более
// старом браузере расширение установилось бы и молча работало без датчика.
check(
  Number(manifest.minimum_chrome_version) >= 111,
  `манифест: minimum_chrome_version ≥ 111 (${manifest.minimum_chrome_version})`,
);

// ============ поведение ============

console.log("\n— поведение —");

// --- 1: типовой — ссылка открылась, фокус ушёл приложению ---
await reset();
windows.set(1, { focused: false }); // десктопное приложение забрало фокус
await emit(listeners.created, tab(10, J360, { active: true }));
check(alarms.has("close:10"), "1a: аларм взведён для фоновой вкладки-посредника");
await fireAlarm("close:10");
check(removed.includes(10) && !tabs.has(10), "1b: вкладка закрыта по аларму");
check(store.local.closed === 1, "1c: счётчик закрытых вкладок вырос");

// --- 2: пользователь смотрит — пауза, ушёл — закрытие ---
await reset();
windows.set(1, { focused: true });
await emit(listeners.created, tab(20, J, { active: true }));
check(!alarms.has("close:20"), "2a: аларм НЕ взведён, пока вкладка в фокусе");
windows.set(1, { focused: false });
await emit(listeners.focus, -1);
check(alarms.has("close:20"), "2b: уход из окна взводит аларм");
await fireAlarm("close:20");
check(removed.includes(20), "2c: закрыта после ухода");

// --- 3: звонок в браузере (audible) — откладываем ---
await reset();
windows.set(1, { focused: false });
await emit(listeners.created, tab(30, J, { audible: true }));
await fireAlarm("close:30");
check(!removed.includes(30) && tabs.has(30), "3a: audible-вкладка не закрыта");
check(alarms.has("close:30"), "3b: проверка отложена (аларм перевзведён)");

// --- 4: закреплённая вкладка ---
await reset();
windows.set(1, { focused: false });
await emit(listeners.created, tab(40, J360, { pinned: true }));
await fireAlarm("close:40");
check(tabs.has(40) && alarms.has("close:40"), "4: pinned-вкладка не закрыта, проверка отложена");

// --- 5: чужие URL не трогаем ---
await reset();
windows.set(1, { focused: false });
for (const [i, url] of [...FOREIGN, ...ROOTS].entries()) {
  await emit(listeners.created, tab(50 + i, url));
}
check(alarms.size === 0, "5: посторонние URL не получают алармов");

// --- 6: рестарт браузера с восстановленной вкладкой ---
await reset();
windows.set(1, { focused: false });
tab(60, J360);
await emit(listeners.startup);
check(alarms.has("close:60"), "6: onStartup подхватывает восстановленные вкладки");

// --- 7: отсчёт не сбрасывается чужими переключениями ---
await reset();
windows.set(1, { focused: true });
await emit(listeners.created, tab(70, J));
const when1 = alarms.get("close:70").when;
await new Promise((r) => setTimeout(r, 15));
await emit(listeners.activated, { tabId: 999, windowId: 1 });
check(alarms.get("close:70").when === when1, "7a: существующий отсчёт не пересоздаётся");
tabs.set(70, { ...tabs.get(70), active: true });
await emit(listeners.activated, { tabId: 70, windowId: 1 });
check(!alarms.has("close:70"), "7b: возврат на вкладку ставит отсчёт на паузу");

// --- 8: уход со страницы-посредника снимает слежку ---
await reset();
windows.set(1, { focused: false });
await emit(listeners.created, tab(80, J));
tabs.set(80, { ...tabs.get(80), url: "https://ya.ru/" });
await emit(listeners.updated, 80, { url: "https://ya.ru/" }, tabs.get(80));
check(!alarms.has("close:80"), "8a: навигация прочь снимает аларм");
// А если события не было (на новый URL у нас нет прав) — аларм снимется сам
// при срабатывании, и вкладка останется жива.
await reset();
windows.set(1, { focused: false });
await emit(listeners.created, tab(81, J));
tabs.set(81, { ...tabs.get(81), url: undefined }); // так браузер отдаёт чужую вкладку
await fireAlarm("close:81");
check(tabs.has(81) && !alarms.has("close:81"), "8b: вкладка без прав не закрывается, аларм снят");

// --- 9: вкладку закрыли руками ---
await reset();
windows.set(1, { focused: false });
await emit(listeners.created, tab(90, J));
tabs.delete(90);
await emit(listeners.removedTab, 90);
check(!alarms.has("close:90"), "9: ручное закрытие вычищает аларм");

// --- 10: фокус ушёл приложению, а события onFocusChanged НЕТ ---
// Так ведёт себя macOS при запуске десктопного клиента: окно честно сообщает
// focused: false, но событие не приходит. Спасает только тик.
await reset();
windows.set(1, { focused: true });
await emit(listeners.created, tab(100, J360, { active: true }));
check(alarms.has("tick"), "10a: появился кандидат — тик опроса включён");
check(!alarms.has("close:100"), "10b: пока вкладка в фокусе, отсчёта нет");
windows.set(1, { focused: false });
await fireAlarm("tick");
check(alarms.has("close:100"), "10c: тик заметил потерю фокуса и взвёл отсчёт");
await fireAlarm("close:100");
check(removed.includes(100), "10d: хвостовая вкладка закрыта без события фокуса");
await emit(listeners.removedTab, 100);
check(!alarms.has("tick"), "10e: последний кандидат закрыт — тик выключен");

// --- 11: content.js сообщает об уходе фокуса ---
await reset();
windows.set(1, { focused: true });
await emit(listeners.created, tab(110, J360, { active: true }));
check(!alarms.has("close:110"), "11a: пока страница в фокусе, отсчёта нет");
await emit(listeners.message, { type: "page", state: { watched: false } }, { tab: tabs.get(110), url: J360 });
await settle();
check(alarms.has("close:110"), "11b: blur со страницы взводит отсчёт сразу");
await emit(listeners.message, { type: "page", state: { watched: true } }, { tab: tabs.get(110), url: J360 });
await settle();
check(!alarms.has("close:110"), "11c: возврат фокуса на страницу снимает отсчёт");
await emit(listeners.message, { type: "page", state: { watched: false } }, { tab: tabs.get(110), url: J360 });
await settle();
windows.set(1, { focused: false });
await fireAlarm("close:110");
check(removed.includes(110), "11d: по отсчёту от blur вкладка закрыта");

// Решение принимается по свежему состоянию, а не по старому сообщению.
await reset();
windows.set(1, { focused: true });
tab(111, J360, { active: true });
await emit(listeners.message, { type: "page", state: { watched: false } }, { tab: tabs.get(111), url: J360 });
await settle();
await fireAlarm("close:111");
check(tabs.has(111), "11e: вернувшийся к вкладке пользователь спасает её от закрытия");

// --- 12: чужие и битые сообщения ---
await reset();
windows.set(1, { focused: true });
tab(120, "https://ya.ru/", { active: true });
await emit(listeners.message, { type: "page", state: { watched: false } }, { tab: tabs.get(120), url: "https://ya.ru/" });
await emit(listeners.message, { hello: 1 }, { tab: tabs.get(120), url: J360 });
await emit(listeners.message, { type: "page", state: { watched: false } }, {});
await settle();
check(alarms.size === 0, "12: посторонние сообщения не взводят отсчётов");

// ============ новые защиты v2 ============

console.log("\n— защиты v2 —");

// --- 13: страница говорит «во мне играет медиа» — звонок идёт в браузере ---
// Главная защита для платформ, которые я не проверял вживую: если ссылка
// на самом деле ведёт прямо в звонок, здесь мы это увидим.
await reset();
windows.set(1, { focused: false });
await emit(listeners.created, tab(130, "https://acme.zoom.us/j/93312345678"));
pages.set(130, { watched: false, busy: true });
await fireAlarm("close:130");
check(tabs.has(130), "13a: вкладка с играющим медиа не закрыта");
check(alarms.has("close:130"), "13b: проверка отложена");
pages.set(130, { watched: false, busy: false }); // звонок кончился
await fireAlarm("close:130");
check(removed.includes(130), "13c: как только медиа стихло — закрыта");

// --- 14: страница говорит «на меня смотрят» в момент решения ---
await reset();
windows.set(1, { focused: false });
await emit(listeners.created, tab(140, J));
pages.set(140, { watched: true, busy: false });
await fireAlarm("close:140");
check(tabs.has(140) && alarms.has("close:140"), "14: страница в фокусе — не закрыта");

// --- 15: content script не загружен (вкладка из восстановленной сессии) ---
await reset();
windows.set(1, { focused: false });
await emit(listeners.created, tab(150, J360));
await fireAlarm("close:150"); // pages пуст — sendMessage бросает
check(removed.includes(150), "15: без ответа страницы решаем по данным браузера");

// ============ платформы, где звонок идёт в браузере ============

console.log("\n— звонок по адресу приглашения —");

const MEET = "https://meet.google.com/abc-defg-hij";
const enableMeet = () => setSync({ enabled: { meet: true } });

// --- 18: встреча идёт — вкладку держит защита ---
await reset();
await enableMeet();
windows.set(1, { focused: false });
pages.set(180, { watched: false, busy: true });
await emit(listeners.created, tab(180, MEET));
await fireAlarm("close:180");
check(tabs.has(180), "18a: во время встречи вкладка не закрыта");
check(alarms.has("close:180"), "18b: проверка отложена");

// --- 19: вышли из встречи — закрываем по общему правилу ---
// Отдельного признака «звонок закончился» нет и не нужно: закончившийся
// звонок — это просто отсутствие живого.
pages.set(180, { watched: false, busy: false });
await fireAlarm("close:180");
check(removed.includes(180), "19: как только звонка нет — вкладка закрыта");

// --- 20: корень домена не трогаем никогда ---
// Это единственное, ради чего гейт смотрит на путь: `meet.google.com/` —
// список встреч, а не хвост.
await reset();
await enableMeet();
windows.set(1, { focused: false });
for (const [i, url] of ["https://meet.google.com/", "https://meet.google.com"].entries()) {
  await emit(listeners.created, tab(200 + i, url));
}
check(alarms.size === 0, "20: корень домена не получает отсчёта");

// --- 21: страница молчит — решаем по данным браузера ---
// Ровно то, что делала первая версия и что работает в проде: человек открыл
// «присоединиться», ушёл на другую вкладку — через 30 секунд можно закрыть.
await reset();
await enableMeet();
windows.set(1, { focused: false });
await emit(listeners.created, tab(210, MEET)); // pages пуст — content script не ответит
check(alarms.has("close:210"), "21a: отсчёт идёт и без ответа страницы");
await fireAlarm("close:210");
check(removed.includes(210), "21b: вкладка закрыта по данным браузера");

// --- 21в: две вкладки закрываются одновременно — счётчик не теряет инкремент ---
// Алармы хвостов срабатывают в один тик, а инкремент через storage —
// это read-modify-write. Ловилось живым прогоном: было 3 вместо 4.
await reset();
windows.set(1, { focused: false });
await emit(listeners.created, tab(215, J));
await emit(listeners.created, tab(216, J360));
await Promise.all([fireAlarm("close:215"), fireAlarm("close:216")]);
await settle();
check(store.local.closed === 2, `21в: счётчик после двух одновременных закрытий = ${store.local.closed}`);

// --- 22: выключенная платформа не наблюдается ---
await reset();
windows.set(1, { focused: false });
await emit(listeners.created, tab(220, MEET)); // meet по умолчанию выключен
check(!alarms.has("close:220"), "22: пока платформа не включена, её вкладки не наши");

// --- 23: разрешение выдали — скрипты зарегистрировались ---
await reset();
windows.set(1, { focused: false });
check(registered.length === 0, "23a: без разрешений динамических скриптов нет");
const meetPlatform = PLATFORMS.find((p) => p.id === "meet");
tab(230, MEET); // открыта ДО выдачи доступа — статическая регистрация её не покроет
tab(231, J); // чужая для этого разрешения вкладка — трогать не должны
await chrome.permissions.request({ origins: meetPlatform.match });
await emit(listeners.permAdded, { origins: meetPlatform.match, permissions: [] });
await settle();
check(registered.length === 2, `23b: после выдачи доступа зарегистрированы оба скрипта (${registered.length})`);
check(
  registered.some((s) => s.world === "MAIN" && s.js.includes("rtc-probe.js")),
  "23c: датчик WebRTC зарегистрирован в MAIN world",
);
check(
  registered.every((s) => sameSet(s.matches, meetPlatform.match)),
  "23d: скрипты зарегистрированы только на выданные домены",
);
check(
  injected.length === 2 && injected.every((i) => i.target.tabId === 230),
  `23e: в уже открытую вкладку Meet оба скрипта внедрены вручную, в чужую — нет (${injected.length})`,
);
check(
  injected.some((i) => i.world === "MAIN" && i.files.includes("rtc-probe.js")) &&
    injected.some((i) => i.world === undefined && i.files.includes("content.js")),
  "23f: датчик внедрён в MAIN world, content.js — в изолированный",
);
await chrome.permissions.remove({ origins: meetPlatform.match });
await emit(listeners.permRemoved, { origins: meetPlatform.match, permissions: [] });
await settle();
check(registered.length === 0, "23g: доступ отозвали — регистрации сняты");

// --- 24: установка/обновление расширения при открытых вкладках ---
// Content scripts браузер ставит только в страницы, загруженные после
// регистрации. Вкладка со звонком, открытая до обновления, осталась бы без
// глаз — и её закрыло бы по данным браузера.
await reset();
windows.set(1, { focused: false });
tab(240, J360);
tab(241, "https://acme.zoom.us/wc/93312345678/join");
tab(242, "https://ya.ru/");
await emit(listeners.installed, { reason: "update" });
await settle();
check(
  injected.filter((i) => i.target.tabId === 240).length === 2 &&
    injected.filter((i) => i.target.tabId === 241).length === 2 &&
    !injected.some((i) => i.target.tabId === 242),
  `24a: при обновлении скрипты внедрены во все открытые вкладки ВКС и ни в одну чужую (${injected.length})`,
);
check(alarms.has("close:240") && alarms.has("close:241"), "24b: и отсчёт для них взведён");
await reset();
tab(243, J360);
await emit(listeners.installed, { reason: "chrome_update" });
await settle();
check(injected.length === 0, "24c: обновление самого браузера скрипты заново не внедряет");

// ============ настройки ============

console.log("\n— настройки —");

// --- 16: выключенная платформа не трогается ---
await reset();
windows.set(1, { focused: false });
await setSync({ enabled: { zoom: false } });
await emit(listeners.created, tab(160, "https://zoom.us/j/93312345678"));
check(!alarms.has("close:160"), "16a: выключенная платформа не получает отсчёта");
await emit(listeners.created, tab(161, J)); // остальные продолжают работать
check(alarms.has("close:161"), "16b: остальные платформы работают");

// Уже взведённый отсчёт снимается, когда платформу выключили.
await reset();
windows.set(1, { focused: false });
await emit(listeners.created, tab(162, "https://zoom.us/j/93312345678"));
check(alarms.has("close:162"), "16c: пока включена — отсчёт идёт");
await setSync({ enabled: { zoom: false } });
await settle();
check(!alarms.has("close:162"), "16d: выключили платформу — отсчёт снят сразу, без других событий");

// Включили платформу — уже открытые вкладки подхватываются сразу.
await reset();
windows.set(1, { focused: false });
tab(163, MEET);
await enableMeet();
await settle();
check(alarms.has("close:163"), "16e: включили платформу — открытая вкладка получила отсчёт сразу");

// --- 17: задержка из настроек ---
await reset();
windows.set(1, { focused: false });
await setSync({ delaySeconds: 120 });
const t0 = Date.now();
await emit(listeners.created, tab(170, J360));
const delay = alarms.get("close:170").when - t0;
check(delay > 110_000 && delay < 130_000, `17: аларм взведён на 120 с (получилось ${Math.round(delay / 1000)} с)`);

// Меньше 30 с упакованное расширение всё равно не получит: браузер
// откладывает аларм до 30 с. Не обещаем и в настройках.
await reset();
windows.set(1, { focused: false });
await setSync({ delaySeconds: 15 });
const t1 = Date.now();
await emit(listeners.created, tab(171, J360));
const clamped = alarms.get("close:171").when - t1;
check(clamped >= 29_000 && clamped < 31_000, `17b: задержка меньше 30 с поднимается до 30 (получилось ${Math.round(clamped / 1000)} с)`);
check(
  !read("extension/options.html").includes('value="15"'),
  "17c: в настройках нет варианта короче 30 с",
);

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
