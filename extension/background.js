// Уборка хвостовых вкладок.
//
// Закрывает вкладки, которые передали действие приложению или отработали
// своё: страницы-посредники, отдавшие звонок или чат десктопному приложению,
// страницы звонка, из которого человек уже вышел, страницы «открыть
// в Telegram» после клика, финиши входа в CLI. Список сервисов — в platforms.js.
//
// Вся логика сходится в reconcile(tab): привести аларм вкладки в правильное
// состояние. Функция идемпотентна, поэтому события могут вызывать её сколько
// угодно раз без гонок. Состояние нигде не хранится: перечень «кандидатов»
// выводится из открытых вкладок (tabs.query), а взведённые таймеры живут
// в chrome.alarms и переживают выгрузку service worker'а.

if (typeof importScripts === "function") importScripts("./platforms.js");

const ALARM_PREFIX = "close:";

// Тик-опрос — страховка. На macOS браузер НЕ присылает
// windows.onFocusChanged, когда фокус уходит другому приложению, — а это
// как раз наш главный сценарий (ссылку открыли, десктопное приложение забрало
// фокус, вкладка осталась активной). Проверено вживую: windows.get().focused
// при этом честно возвращает false, но события нет. Точный момент ухода
// сообщает content.js; тик остаётся для вкладок, где его нет вовсе:
// восстановленных после перезапуска и не загруженных, открытых до установки
// расширения. Пока есть хоть один кандидат, раз в TICK_MINUTES пересматриваем
// их сами. 0.5 — минимальный период, который разрешает MV3.
const TICK_ALARM = "tick";
const TICK_MINUTES = 0.5;

const DEFAULT_ENABLED = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.defaultOn]));

// Service worker выгружается, поэтому настройки читаются из storage, а не
// живут в памяти. Кэш — чтобы не дёргать storage на каждое событие фокуса;
// сбрасывается, как только настройки поменяли. Заодно пересматриваем
// кандидатов: включённая платформа должна подхватить уже открытые вкладки
// сразу, а не по следующему переключению вкладок.
let cache = null;
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== "sync") return;
  cache = null;
  reconcileAll();
});

async function settings() {
  if (cache) return cache;
  const raw = await chrome.storage.sync.get(["delaySeconds", "enabled"]);
  cache = {
    delaySeconds: effectiveDelay(raw.delaySeconds),
    enabled: { ...DEFAULT_ENABLED, ...(raw.enabled ?? {}) },
  };
  return cache;
}

// Платформа, за которой числится URL, — и только если она включена
// в настройках. Единственный вход в реестр: больше нигде не решаем,
// «наш» это адрес или нет.
async function activePlatform(url) {
  if (!url) return null;
  const platform = PLATFORMS.find((p) => p.test.test(url));
  if (!platform) return null;
  return (await settings()).enabled[platform.id] ? platform : null;
}

// Очередь вызовов внутри одного пробуждения worker'а: следующий начинается,
// когда закончился предыдущий, даже если тот упал. Нужна везде, где
// обработчик делает read-modify-write чужого состояния, а события приходят
// пачкой.
function serial(fn) {
  let tail = Promise.resolve();
  return (...args) => (tail = tail.catch(() => {}).then(() => fn(...args)));
}

// ── Опциональные разрешения ───────────────────────────────────────────────
// Домены платформ с `optional` не просятся при установке: за десяток лишних
// сайтов в предупреждении платили бы все, а нужны они немногим. Пользователь
// выдаёт их галочкой в настройках, и только тогда мы регистрируем на них
// скрипты. Статически объявить их в манифесте нельзя — браузер не станет
// внедрять скрипт на домен, разрешения на который нет.

const DYNAMIC_IDS = ["optional-content", "optional-rtc-probe"];

// Снимаем всегда и регистрируем заново: разбираться, какие из двух
// регистраций уже есть, дороже, чем просто пересоздать их. Зато вызовы
// обязаны идти строго по очереди. Две пересинхронизации разом (выключили
// две платформы подряд, выдали доступ во время обновления) переплетаются:
// обе снимают, обе регистрируют, и вторая падает на «Duplicate script ID» —
// проверено в браузере. А первая к тому же могла зарегистрировать список
// доменов, устаревший к моменту записи.
const syncOptionalScripts = serial(async () => {
  const granted = [];
  for (const p of PLATFORMS) {
    if (!p.optional) continue;
    if (await chrome.permissions.contains({ origins: p.match })) granted.push(...p.match);
  }

  try {
    await chrome.scripting.unregisterContentScripts({ ids: DYNAMIC_IDS });
  } catch {
    // ни одной регистрации не было — это норма
  }
  if (!granted.length) return;

  await chrome.scripting.registerContentScripts([
    {
      id: DYNAMIC_IDS[0],
      matches: granted,
      js: ["content.js"],
      runAt: "document_start",
      allFrames: false,
    },
    {
      id: DYNAMIC_IDS[1],
      matches: granted,
      js: ["rtc-probe.js"],
      runAt: "document_start",
      allFrames: false,
      world: "MAIN",
    },
  ]);
});

// Content scripts — и статические, и зарегистрированные — попадают только
// в страницы, загруженные ПОСЛЕ регистрации. Вкладки, открытые до установки
// или обновления расширения и до выдачи разрешения, остаются без глаз:
// страница молчит, а молчание считается «не занята» — и вкладку с идущим
// звонком закрыло бы по данным браузера. Поэтому в уже открытые вкладки
// скрипты внедряются вручную. Датчик WebRTC, внедрённый с опозданием,
// соединений, созданных до него, не увидит — но защита медиаэлементов
// работает сразу, а все новые соединения он посчитает.
async function injectIntoOpenTabs(matches) {
  if (!matches.length) return;
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.all(
    tabs.flatMap((tab) => [
      { target: { tabId: tab.id }, files: ["content.js"] },
      { target: { tabId: tab.id }, files: ["rtc-probe.js"], world: "MAIN" },
    ].map((injection) => chrome.scripting.executeScript(injection).catch(() => {}))),
  );
}

// Пересобрать регистрации, при необходимости внедрить скрипты в уже открытые
// вкладки и пересмотреть кандидатов. Сбой регистрации не отменяет остального:
// вкладки пересматриваются в любом случае.
async function refresh(injectInto = []) {
  await syncOptionalScripts().catch((e) => console.error("регистрация скриптов:", e));
  await injectIntoOpenTabs(injectInto);
  await reconcileAll();
}

chrome.permissions.onAdded.addListener((granted) => refresh(granted?.origins ?? []));
chrome.permissions.onRemoved.addListener(() => refresh());

// ── Таймеры ───────────────────────────────────────────────────────────────

function clearAlarm(tabId) {
  return chrome.alarms.clear(ALARM_PREFIX + tabId);
}

async function schedule(name) {
  const { delaySeconds } = await settings();
  await chrome.alarms.create(name, { when: Date.now() + delaySeconds * 1000 });
}

// Взводит отсчёт, если он ещё не идёт. Существующий аларм не трогаем,
// иначе любое событие (переключение чужих вкладок) сбрасывало бы отсчёт.
async function armAlarm(tabId) {
  const name = ALARM_PREFIX + tabId;
  if (await chrome.alarms.get(name)) return;
  await schedule(name);
}

// Тик нужен, только пока на экране есть вкладки-кандидаты: иначе он зря
// будил бы service worker каждые полминуты. Существующий не пересоздаём,
// чтобы не сдвигать фазу опроса.
async function setTick(needed) {
  const exists = !!(await chrome.alarms.get(TICK_ALARM));
  if (needed && !exists) {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES });
  } else if (!needed && exists) {
    await chrome.alarms.clear(TICK_ALARM);
  }
}

// Пользователь смотрит на вкладку: она активна И её окно в фокусе.
async function isForeground(tab) {
  if (!tab.active) return false;
  try {
    return (await chrome.windows.get(tab.windowId)).focused;
  } catch {
    return false;
  }
}

// Спрашиваем саму страницу в момент решения, а не полагаемся на последнее
// присланное ею сообщение: за время отсчёта человек мог вернуться или начать
// звонок прямо в браузере. Нет ответа — значит content script не загружен
// (вкладка восстановлена из сессии, скрипт не внедрён).
async function askPage(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "state" });
  } catch {
    return null;
  }
}

// Записи реестра с `handoff` — страницы, где рядом с кнопкой «открыть
// в приложении» лежит содержимое. Такая вкладка становится кандидатом, только
// когда страница сама сказала, что передала действие приложению. Нет ответа —
// не кандидат: молчание разрешением закрыть не считается.
const handedOff = (platform, page) => !platform.handoff || page?.handedOff === true;

// Страница занята: человек на неё смотрит или в ней идёт звонок.
// Молчание страницы занятостью НЕ считается — content script мог не
// внедриться, вкладка могла восстановиться из сессии. Тогда решаем
// по данным браузера, ровно как это делала первая версия.
const busy = (state) => state?.watched === true || state?.busy === true;

// Инкремент через storage — это read-modify-write, а закрываются вкладки
// пачкой: алармы нескольких хвостов срабатывают в один тик, все читают
// одно и то же значение и записывают одно и то же. Счётчик недосчитывал.
// Очереди внутри одного пробуждения worker'а достаточно: между
// пробуждениями одновременных закрытий не бывает.
const countClosed = serial(async () => {
  const { closed = 0 } = await chrome.storage.local.get("closed");
  await chrome.storage.local.set({ closed: closed + 1 });
});

// Приводит аларм одной вкладки в правильное состояние и отвечает, кандидат
// ли она. Тик здесь не трогаем — им распоряжаются вызывающие.
async function reconcileTab(tab) {
  if (tab.id === undefined) return false;
  const platform = await activePlatform(tab.url);
  const page = platform?.handoff ? await askPage(tab.id) : undefined;
  if (!platform || !handedOff(platform, page)) {
    await clearAlarm(tab.id);
    return false;
  }
  // Вкладка на глазах — пауза: отсчёт перевзведётся, когда пользователь
  // уйдёт (onActivated / onFocusChanged / сообщение от страницы).
  await ((await isForeground(tab)) ? clearAlarm(tab.id) : armAlarm(tab.id));
  return true;
}

async function reconcile(tab) {
  if (await reconcileTab(tab)) await setTick(true);
}

async function reconcileAll() {
  const tabs = await chrome.tabs.query({ url: ALL_MATCHES });
  const candidates = await Promise.all(tabs.map(reconcileTab));
  await setTick(candidates.includes(true));
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TICK_ALARM) {
    await reconcileAll();
    return;
  }
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(ALARM_PREFIX.length));

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // вкладки уже нет
  }

  // Вкладка ушла с наблюдаемого адреса. Отдельная ветка потому, что события
  // об этом мы могли не получить: на посторонний URL у нас нет прав,
  // и changeInfo.url до нас не доходит.
  const platform = await activePlatform(tab.url);
  if (!platform) {
    await clearAlarm(tabId);
    return;
  }

  if (await isForeground(tab)) return; // пауза до ухода с вкладки

  // Защиты от закрытия живого звонка и осознанно закреплённых вкладок:
  // не отменяем слежку, а откладываем проверку ещё на цикл.
  if (tab.audible || tab.pinned) {
    await schedule(alarm.name);
    return;
  }

  // Последняя и самая надёжная защита: страница сама говорит, идёт ли в ней
  // звонок. Живое WebRTC-соединение или играющий медиаэлемент — оба признака
  // работают и там, где tab.audible молчит, потому что в комнате тишина.
  const page = await askPage(tabId);
  if (!handedOff(platform, page)) return; // не кандидат
  if (busy(page)) {
    await schedule(alarm.name);
    return;
  }

  try {
    await chrome.tabs.remove(tabId);
    await countClosed();
  } catch {
    // вкладку успели закрыть вручную — не страшно
  }
});

// Главный источник правды о том, ушёл ли пользователь: сама страница
// (content.js). Она ловит blur в тот же момент, когда фокус забирает
// десктопное приложение, и сообщает о завершении звонка сразу, как только
// закрылось соединение. Решение о закрытии всё равно перепроверяется
// целиком при срабатывании аларма.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "page" || !msg.state) return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  onPageReport(tabId, sender.url ?? sender.tab.url, msg.state);
});

async function onPageReport(tabId, url, state) {
  const platform = await activePlatform(url);
  if (!platform) return;
  if (busy(state) || !handedOff(platform, state)) {
    await clearAlarm(tabId);
  } else {
    await setTick(true);
    await armAlarm(tabId);
  }
}

chrome.tabs.onCreated.addListener(reconcile);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined) reconcile(tab);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearAlarm(tabId);
  await reconcileAll(); // ушёл последний кандидат — гасим тик
});

// Смена активной вкладки или фокуса окон (в т.ч. фокус ушёл десктопному
// приложению — WINDOW_ID_NONE, наш главный сценарий): пересматриваем всех
// кандидатов разом, их единицы.
chrome.tabs.onActivated.addListener(() => reconcileAll());
chrome.windows.onFocusChanged.addListener(() => reconcileAll());

// Старт браузера (восстановленная сессия) и установка/обновление
// расширения: подхватить уже открытые хвосты и восстановить регистрации.
// При установке и обновлении ещё и внедрить скрипты в открытые вкладки:
// после обновления старые content scripts мертвы (их runtime отозван),
// а новые браузер сам в живые страницы не ставит. Что новый скрипт в такой
// вкладке действительно оживает, проверено в браузере (2026-10-12).
chrome.runtime.onStartup.addListener(() => refresh());
chrome.runtime.onInstalled.addListener(({ reason } = {}) =>
  refresh(reason === "install" || reason === "update" ? ALL_MATCHES : []),
);
