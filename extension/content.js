// Глаза расширения на самой странице встречи. Отвечает на три вопроса.
//
// 1. «Смотрит ли на меня пользователь». Service worker не может узнать
//    момент, когда фокус ушёл из браузера в десктопное приложение: события
//    windows.onFocusChanged на macOS в этот момент нет. А страница про себя
//    это знает — ей приходит window.blur.
//
// 2. «Идёт ли во мне звонок» (busy). Последняя защита от закрытия вкладки,
//    в которой человек реально разговаривает. Два независимых признака,
//    достаточно любого:
//    - живое WebRTC-соединение — точный ответ уровня протокола, его даёт
//      rtc-probe.js через атрибут на <html> (миры делят DOM, но не
//      переменные). Работает и когда в комнате тишина, и когда у человека
//      выключены камера с микрофоном;
//    - играющий медиаэлемент: удалённое видео, удалённый звук или превью
//      собственной камеры (для <video srcObject=MediaStream> это тоже
//      «играет»). Страховка на случай, если подменить RTCPeerConnection
//      не удалось или звонок идёт мимо WebRTC. Он же держит вкладку в момент
//      подключения, когда соединение ещё не дошло до connected.
//
// Отдельного признака «звонок закончился» не нужно: закончившийся звонок —
// это просто отсутствие живого. Дальше решает общее правило.
//
// Состояние отдаётся двумя способами: push при каждом изменении (чтобы
// вовремя начать отсчёт) и pull в момент, когда решается судьба вкладки
// (чтобы решать по свежему, а не по последнему присланному).

const state = () => {
  // Просим датчик опубликовать свежее состояние: событие на общем DOM
  // доходит в MAIN world и обрабатывается синхронно.
  document.documentElement?.dispatchEvent(new Event("mtc-refresh"));
  return {
    watched: document.visibilityState === "visible" && document.hasFocus(),
    busy: inCall() || capturing() || playingMedia(),
  };
};

const rootHas = (attr) => document.documentElement?.hasAttribute(attr) ?? false;
// Живое WebRTC-соединение — человек во встрече.
const inCall = () => rootHas("data-mtc-call");
// Страница держит камеру, микрофон или экран — человек входит во встречу
// (экран входа, зал ожидания) или делится экраном. Посредник, отдавший
// звонок приложению, этого не делает никогда.
const capturing = () => rootHas("data-mtc-capture");

const playingMedia = () =>
  [...document.querySelectorAll("video, audio")].some(
    (el) => !el.paused && !el.ended && el.readyState > 2,
  );

const report = () => {
  // sendMessage отвергается, если service worker как раз перезагружают, —
  // это нормально, следующее событие всё поправит. А после обновления
  // расширения старый скрипт остаётся в странице с отозванным runtime
  // и бросает уже синхронно — глотаем и это, чужую консоль не засоряем.
  try {
    chrome.runtime.sendMessage({ type: "page", state: state() }).catch(() => {});
  } catch {
    // Extension context invalidated
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "state") return;
  sendResponse(state());
});

addEventListener("focus", report);
addEventListener("blur", report);
addEventListener("pageshow", report); // возврат из bfcache
document.addEventListener("visibilitychange", report);

// Датчик WebRTC общается с нами через атрибуты на <html>: следим за ними,
// чтобы момент выхода из встречи доходил до service worker сразу, а не
// ждал ближайшего тика. На document_start корневого элемента может ещё
// не быть — тогда дожидаемся его появления.
const watchRoot = () => {
  if (!document.documentElement) {
    // Именно setTimeout, а не requestAnimationFrame: вкладка-посредник
    // часто открывается в фоне, а кадры в фоновой вкладке не идут вовсе.
    setTimeout(watchRoot, 0);
    return;
  }
  // Реагируем только на настоящую смену значения. Наблюдатель срабатывает
  // и на запись того же значения, а report() просит датчик опубликовать
  // состояние заново — без этой проверки получился бы вечный цикл
  // микрозадач. Датчик со своей стороны тоже не пишет без изменений;
  // защита двойная, потому что цена ошибки — намертво зависшая встреча.
  new MutationObserver((records) => {
    const changed = records.some(
      (r) => r.oldValue !== document.documentElement.getAttribute(r.attributeName),
    );
    if (changed) report();
  }).observe(document.documentElement, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-mtc-call", "data-mtc-capture"],
  });
};
watchRoot();

report();
