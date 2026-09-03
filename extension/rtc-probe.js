// Датчик живого звонка. Работает в MAIN world — то есть в контексте самой
// страницы, а не в изолированном мире расширения.
//
// ЗАЧЕМ. Адрес страницы не отвечает на вопрос «идёт ли здесь звонок».
// У Телемоста `…/j/<id>` — это и страница-посредник, запускающая десктопное
// приложение, и место, где идёт звонок, если нажать «Продолжить в браузере».
// Один URL, два совершенно разных состояния.
//
// А вот WebRTC отвечает точно: любая ВКС в браузере ведёт звонок через
// RTCPeerConnection. Соединение перешло в `connected` — человек во встрече;
// закрылось — вышел. Это событие уровня протокола: не зависит ни от вёрстки
// конкретного сервиса, ни от того, говорит ли кто-нибудь в комнате.
//
// ПОЧЕМУ `connected`, А НЕ САМ ФАКТ СОЗДАНИЯ. Страницы регулярно создают
// RTCPeerConnection для проверки связи и сбора ICE-кандидатов, никуда при этом
// не подключаясь. Такая проба до `connected` не доходит. Считать её звонком
// значило бы никогда не закрывать вкладку-посредник — то есть сломать всю
// функцию, причём молча.
//
// Обратная сторона: вкладку, которая ПРЯМО СЕЙЧАС подключается к встрече,
// этот датчик ещё не защищает. Её защищает проверка медиаэлементов —
// на экране подключения обычно уже крутится превью своей камеры. Считать
// живым и `connecting` заманчиво, но тогда одна незакрытая проба ломает
// основной сценарий, а цена ошибки в другую сторону покрыта другой защитой.
//
// КАК ПЕРЕДАЁМ НАРУЖУ. MAIN и ISOLATED world не видят переменных друг друга,
// но делят DOM. Атрибут на <html> — самый простой общий канал, и он читается
// в момент решения, а не приходит событием, которое надо где-то хранить.
// Страница теоретически может подделать атрибут — максимум, чего она этим
// добьётся, это что её вкладку не закроют.
//
// Подмена должна быть незаметной: страница не должна отличить обёртку от
// оригинала, иначе мы сломаем чужой звонок ради того, чтобы его не закрыть.

(() => {
  const Native = globalThis.RTCPeerConnection;
  if (typeof Native !== "function") return;

  // Датчик может приехать дважды: статически при загрузке страницы и вручную
  // при установке/обновлении расширения в уже открытую вкладку. Второй
  // экземпляр обернул бы обёртку — ничего не сломал бы, но и не нужен.
  const MARK = Symbol.for("mtc-probe");
  if (Native[MARK]) return;

  const CALL = "data-mtc-call"; // прямо сейчас идёт звонок
  // Страница держит камеру или микрофон. Это не звонок, но это «я вхожу
  // во встречу»: экран входа с выключенной камерой, зал ожидания, пока
  // организатор не впустил, — соединения ещё нет, а человека из очереди
  // выкидывать нельзя. Страница-посредник, отдавшая звонок приложению,
  // камеру не просит никогда, поэтому основной сценарий этот признак
  // не задевает. Сюда же попадает демонстрация экрана.
  const CAPTURE = "data-mtc-capture";

  const live = new Set();
  const tracks = new Set();

  // track.stop() событие ended НЕ шлёт, поэтому дорожки не вычитаются
  // по событию, а перепроверяются по readyState в момент публикации.
  const liveTracks = () => {
    for (const t of tracks) if (t.readyState !== "live") tracks.delete(t);
    return tracks.size;
  };

  // Атрибут трогаем ТОЛЬКО когда значение меняется. MutationObserver
  // в content.js срабатывает и на запись того же значения, а он в ответ
  // просит нас опубликовать состояние заново (mtc-refresh) — запись без
  // проверки замыкала бы это в бесконечный цикл микрозадач, и страница
  // со звонком висла бы намертво. Поймано live-guard'ом на захвате микрофона.
  const set = (root, attr, count) => {
    if (count) {
      const value = String(count);
      if (root.getAttribute(attr) !== value) root.setAttribute(attr, value);
    } else if (root.hasAttribute(attr)) {
      root.removeAttribute(attr);
    }
  };

  const publish = () => {
    const root = document.documentElement;
    if (!root) return;
    set(root, CALL, live.size);
    set(root, CAPTURE, liveTracks());
  };

  // content.js живёт в другом мире и функций наших не видит, но событие
  // на общем DOM доходит — и обрабатывается синхронно. Так он получает
  // свежее состояние ровно в момент решения, а не последнее опубликованное.
  const REFRESH = "mtc-refresh";
  const watchRefresh = () => {
    if (!document.documentElement) { setTimeout(watchRefresh, 0); return; }
    document.documentElement.addEventListener(REFRESH, publish);
  };
  watchRefresh();

  const md = navigator.mediaDevices;
  for (const method of ["getUserMedia", "getDisplayMedia"]) {
    const native = md?.[method];
    if (typeof native !== "function") continue;
    const wrapped = function (...args) {
      const result = native.apply(this, args);
      // Ошибку (отказ в доступе) не трогаем — страница ждёт именно её.
      Promise.resolve(result).then((stream) => {
        for (const t of stream.getTracks()) {
          tracks.add(t);
          t.addEventListener("ended", publish);
        }
        publish();
      }, () => {});
      return result;
    };
    Object.defineProperty(wrapped, "name", { value: native.name, configurable: true });
    Object.defineProperty(wrapped, "toString", { value: () => native.toString(), configurable: true });
    try {
      md[method] = wrapped;
    } catch {
      // не перезаписывается — остаёмся без этого признака
    }
  }

  const forget = (pc) => {
    if (live.delete(pc)) publish();
  };

  // `disconnected` намеренно не считается смертью: это штатное временное
  // состояние при потере пакетов, звонок из него возвращается.
  const DEAD = new Set(["closed", "failed"]);

  class RTCPeerConnectionWrapper extends Native {
    constructor(...args) {
      super(...args);

      const onState = () => {
        const state = this.connectionState ?? this.iceConnectionState;
        if (state === "connected" || state === "completed") {
          if (!live.has(this)) { live.add(this); publish(); }
        } else if (DEAD.has(state)) {
          forget(this);
        }
      };

      this.addEventListener("connectionstatechange", onState);
      // Запасной канал для сборок, где connectionState не заполняется.
      this.addEventListener("iceconnectionstatechange", onState);
    }

    close() {
      forget(this);
      return super.close();
    }
  }

  // Прозрачность обёртки: имя конструктора, `instanceof`, статические члены
  // и цепочка прототипов должны выглядеть для страницы как у оригинала.
  Object.defineProperty(RTCPeerConnectionWrapper, "name", {
    value: Native.name,
    configurable: true,
  });
  // Распространённая проверка «нативный ли конструктор» — по тексту функции.
  Object.defineProperty(RTCPeerConnectionWrapper, "toString", {
    value: () => Native.toString(),
    configurable: true,
  });
  Object.defineProperty(RTCPeerConnectionWrapper, MARK, { value: true });

  for (const key of ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"]) {
    if (typeof globalThis[key] === "function") {
      try {
        globalThis[key] = RTCPeerConnectionWrapper;
      } catch {
        // свойство не перезаписывается — остаёмся с проверкой медиаэлементов
      }
    }
  }

  // Страница уже могла успеть подставить <html>, а могла и нет.
  publish();
})();
