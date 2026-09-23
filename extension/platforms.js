// Реестр сервисов — единственный источник правды о том, что мы вообще
// трогаем. Исторически здесь были только ВКС; с 3.3.0 — любые вкладки,
// которые передали действие приложению или отработали своё: лаунчеры
// встреч и чатов, страницы «открыть в Telegram», финиши входа в CLI. Отсюда паттерны разъезжаются в манифест (host_permissions,
// optional_host_permissions, content_scripts) и в tabs.query.
// Добавить платформу = добавить сюда запись.
//
// `match`    — match-паттерны для манифеста и tabs.query, заведомо чуть шире.
// `test`     — точный гейт в момент решения; именно он отвечает за то, что
//              `https://telemost.yandex.ru.evil.com/j/1` мимо.
// `optional` — разрешение на домены не просится при установке, а выдаётся
//              пользователем по галочке в настройках.
// `group`    — раздел на странице настроек: встречи (по умолчанию),
//              мессенджеры, вход в CLI. На поведение не влияет.
// `handoff`  — закрывать только после того, как страница передала действие
//              приложению (см. ниже «Лаунчер по кнопке»).
//
// ── Правило одно на всех ──
//
// Раньше здесь было деление на «страница-посредник» и «страница звонка»
// с разными правилами закрытия. Деления больше нет, и это упрощение,
// а не потеря: правило одно — **вкладка не на глазах заданное время
// и ни одна защита не сработала → закрываем**. Оно само разбирает все
// четыре состояния:
//
//   встреча идёт в браузере  → держит живое WebRTC / медиа / звук
//   смотрю на экран входа    → держит фокус, а обычно ещё и превью камеры
//   вышел из встречи         → защиты молчат → закрываем
//   звонок ушёл в приложение → защиты молчат → закрываем
//
// Последние два состояния неразличимы, и различать их не нужно: в обоих
// вкладка не нужна. Ровно это правило работало в v1 и работает в проде.
//
// Единственное следствие, которое приходится учитывать: гейт по URL должен
// исключать корень домена. Комната всегда имеет путь, а вот `meet.google.com/`
// или корень пространства в Толке — это список встреч и личный кабинет,
// и закрывать их нельзя. Отсюда `[^/?#]` в конце регулярок: «путь непустой».
// Там, где формат комнаты документирован (Meet, Chime, МТС Линк), гейт
// требует именно его: у этих сервисов рядом с комнатами живут домашние
// страницы с непустым путём (`meet.google.com/landing`, `app.zoom.us/wc/home`),
// и «путь непустой» их не отсекает.
//
// ── Лаунчер по кнопке ──
//
// Есть страницы, которые сами приложение не запускают, а показывают контент
// и кнопку «Открыть в приложении»: `t.me/<канал>/<пост>` — это сам пост.
// Человек мог открыть пять таких ссылок фоном, чтобы прочитать позже, и общее
// правило закрыло бы их через 30 секунд. Для таких записей `handoff: true`:
// вкладка становится кандидатом, только когда страница сообщила, что ушла
// в приложение, — перешла по ссылке с чужой схемой (`tg://…`). Это ловит
// content.js через Navigation API (2026-09-23, проверено на t.me: клик по
// `tg://resolve` даёт `navigate` с этим адресом, сама страница остаётся).
// Молчание страницы — как и везде — разрешением закрыть не считается.
//
// ── Ссылка из приглашения ≠ адрес вкладки ──
//
// Реестр описывает адрес, на котором вкладка ОКАЗЫВАЕТСЯ, а не тот, что
// в приглашении. Teams и Webex редиректят ссылку на свою страницу-лаунчер
// с другим путём (проверено 2026-09-04 через curl -L), и гейт по адресу
// из приглашения не сработал бы никогда. Новую платформу перед записью
// сюда прогонять через `curl -sIL <ссылка>` и смотреть конечный адрес.

const PLATFORMS = [
  {
    // Гибрид: `…/j/<id>` — и страница запуска приложения, и место, где идёт
    // звонок, если нажать «Продолжить в браузере». По URL не различить,
    // и не надо. Проверено вживую.
    id: "telemost",
    verified: true,
    title: "Яндекс Телемост",
    titleEn: "Yandex Telemost",
    match: [
      "https://telemost.yandex.ru/j/*",
      "https://telemost.360.yandex.ru/j/*",
    ],
    test: /^https:\/\/telemost(\.360)?\.yandex\.ru\/j\//,
    defaultOn: true,
  },
  {
    id: "zoom",
    verified: false,
    title: "Zoom",
    match: [
      "https://*.zoom.us/j/*",
      "https://*.zoom.us/s/*",
      "https://*.zoom.us/wc/*",
      "https://*.zoomgov.com/j/*",
      "https://*.zoomgov.com/s/*",
      "https://*.zoomgov.com/wc/*",
      "https://*.zoom.us/w/*",
      "https://*.zoomgov.com/w/*",
      "https://www.zoom.com/*lp/my-notes*",
    ],
    // /j/ и /s/ — приглашение, /w/ — вебинар (та же страница «Launch
    // Meeting», проверено curl 2026-09-23), /wc/ — веб-клиент. После выхода
    // из встречи в веб-клиенте Zoom уводит вкладку на рекламу своих заметок
    // `www.zoom.com/<локаль>/lp/my-notes?from=web_join_post_meeting` — это
    // тот же хвост, гейт держится за метку `from`. Одна запись на всё:
    // правило одинаковое, а защиты разберутся. В веб-клиенте комната —
    // это /wc/<id>/…, /wc/join/<id> и страница выхода /wc/leave; а вот
    // /wc/home — домашняя страница веб-приложения, её не трогаем.
    test: /^https:\/\/(([\w-]+\.)*(zoom\.us|zoomgov\.com)\/(j\/|s\/|w\/|wc\/(\d+\/|join\/|leave([?#]|$)))|www\.zoom\.com\/([a-z]{2}(-[a-z]{2})?\/)?lp\/my-notes\/?\?([^#]*&)?from=web_join_post_meeting([&#]|$))/,
    defaultOn: true,
  },
  {
    // Ссылки /l/meetup-join/ и /meet/ сервер редиректит на страницу-лаунчер
    // /dl/launcher/launcher.html?…&type=meetup-join|meet — именно она
    // и остаётся висеть. Ссылки на чат, канал и сообщение (/l/chat/,
    // /l/channel/, /l/message/) приходят на тот же лаунчер с type=chat,
    // channel, message (curl 2026-09-23). Кнопка «использовать веб-версию»
    // уводит вкладку с лаунчера, так что сам лаунчер всегда хвост.
    // Веб-клиент на /v2/ сюда не входит: Teams в браузере — это целое
    // рабочее пространство, а не одна встреча, закрывать его нельзя.
    id: "teams",
    verified: false,
    title: "Microsoft Teams",
    match: [
      "https://teams.microsoft.com/l/meetup-join/*",
      "https://teams.microsoft.com/meet/*",
      "https://teams.microsoft.com/dl/launcher/*",
      "https://teams.live.com/l/meetup-join/*",
      "https://teams.live.com/meet/*",
      "https://teams.live.com/dl/launcher/*",
    ],
    test: /^https:\/\/teams\.(microsoft|live)\.com\/(l\/meetup-join\/|meet\/|dl\/launcher\/launcher\.html\?([^#]*&)?type=(meet(up-join)?|chat|channel|message)([&#]|$))/,
    defaultOn: true,
  },
  {
    // j.php?MTID=… редиректит на …/webappng/sites/<site>/meeting/download/<id>
    // (у старых сайтов — …/wbxmjs/joinservice/sites/<site>/meeting/download/…):
    // это и есть страница «запускаем приложение». Остальной webappng —
    // личный кабинет и веб-клиент, его не трогаем.
    id: "webex",
    verified: false,
    title: "Cisco Webex",
    match: [
      "https://*.webex.com/*/j.php*",
      "https://*.webex.com/webappng/sites/*/meeting/download/*",
      "https://*.webex.com/wbxmjs/joinservice/sites/*/meeting/download/*",
    ],
    test: /^https:\/\/([\w-]+\.)*webex\.com\/([^?#]*\/j\.php([?#]|$)|(webappng|wbxmjs\/joinservice)\/sites\/[^/?#]+\/meeting\/download\/)/,
    defaultOn: true,
  },
  {
    // Современные приглашения — meet.goto.com/<id или имя комнаты>;
    // global.gotomeeting.com/join/<id> — старый формат, ссылки ещё ходят.
    // Корень meet.goto.com редиректит в веб-приложение app.goto.com — не наше.
    id: "goto",
    verified: false,
    title: "GoTo Meeting",
    match: [
      "https://*.gotomeeting.com/join/*",
      "https://*.goto.com/join/*",
      "https://meet.goto.com/*",
    ],
    test: /^https:\/\/(([\w-]+\.)*(gotomeeting|goto)\.com\/join\/|meet\.goto\.com\/[^/?#])/,
    defaultOn: true,
  },

  // ── Платформы, чьи домены не просятся при установке ───────────────────
  // У них звонок идёт по адресу приглашения, поэтому гейт — весь домен
  // минус корень. Знать формат комнаты не требуется.
  {
    // Код комнаты — всегда три-четыре-три буквы (abc-defg-hij), формат
    // не менялся с 2017 года; /lookup/<имя> — именованные комнаты Workspace.
    // Всё остальное на домене (/landing, /new, /calendar) — не комнаты.
    id: "meet",
    optional: true,
    verified: false,
    title: "Google Meet",
    match: ["https://meet.google.com/*"],
    test: /^https:\/\/meet\.google\.com\/(_meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[^/?#]+)([/?#]|$)/,
    defaultOn: false,
  },
  {
    // Комната — <пространство>.ktalk.ru/<имя>, имя произвольное (по справке
    // Контура). Служебные страницы пространства по документации не известны,
    // поэтому гейт — весь домен минус корень.
    id: "ktalk",
    optional: true,
    verified: false,
    title: "Контур.Толк",
    titleEn: "Kontur Talk",
    match: ["https://*.ktalk.ru/*"],
    test: /^https:\/\/([\w-]+\.)*ktalk\.ru\/[^/?#]/,
    defaultOn: false,
  },
  {
    // Приглашение — my.mts-link.ru/j/<организация>/<id>; сама комната
    // (и старые ссылки) — events.mts-link.ru/<организация>/<id>. На my.*
    // помимо /j/ живёт личный кабинет — его гейт не пропускает.
    // Историческое имя платформы — webinar.ru, ссылки встречаются до сих пор.
    id: "mtslink",
    optional: true,
    verified: false,
    title: "МТС Линк",
    titleEn: "MTS Link",
    match: ["https://*.mts-link.ru/*", "https://*.webinar.ru/*"],
    test: /^https:\/\/(my\.(mts-link|webinar)\.ru\/j\/[^/?#]+\/[^/?#]+|events\.(mts-link|webinar)\.ru\/[^/?#]+\/\d+)/,
    defaultOn: false,
  },
  {
    // jazz.sber.ru/<код>?psw=… — текущий формат; jazz.sber.ru/#/calls/<код> —
    // старый, с маршрутом в хэше, поэтому у него путь как раз пустой.
    id: "jazz",
    optional: true,
    verified: false,
    title: "СБЕР Джаз",
    titleEn: "SBER Jazz",
    match: ["https://jazz.sber.ru/*"],
    test: /^https:\/\/jazz\.sber\.ru\/([^/?#]|#\/calls\/)/,
    defaultOn: false,
  },
  {
    // 8x8.vc — тот же Jitsi как услуга.
    id: "jitsi",
    optional: true,
    verified: false,
    title: "Jitsi Meet",
    match: ["https://meet.jit.si/*", "https://8x8.vc/*"],
    test: /^https:\/\/(meet\.jit\.si|8x8\.vc)\/[^/?#]/,
    defaultOn: false,
  },
  {
    // Комната — whereby.com/<имя> или <команда>.whereby.com/<имя>, и на том же
    // домене живёт сайт компании. По адресу их не различить, поэтому
    // исключены разделы сайта из его навигации (снято 2026-09-04) и служебные
    // поддомены. Новый раздел маркетинга гейт пропустит — известная цена.
    id: "whereby",
    optional: true,
    verified: false,
    title: "Whereby",
    match: ["https://*.whereby.com/*"],
    test: /^https:\/\/(?!(docs|status|api)\.)([\w-]+\.)*whereby\.com\/(?!(information|user|blog|careers|sitemap\.xml)([/?#]|$))[^/?#]/,
    defaultOn: false,
  },
  {
    // Приглашение chime.aws/<id> сервер редиректит на app.chime.aws/meetings/<id>.
    // Остальной app.chime.aws — веб-приложение целиком (чаты, список встреч),
    // его не трогаем.
    id: "chime",
    optional: true,
    verified: false,
    title: "Amazon Chime",
    match: ["https://app.chime.aws/*"],
    test: /^https:\/\/app\.chime\.aws\/meetings\/[^/?#]/,
    defaultOn: false,
  },

  // ── Мессенджеры ────────────────────────────────────────────────────────
  {
    // t.me/<имя>, t.me/+<приглашение>, t.me/<канал>/<пост>, t.me/addstickers/…
    // — все показывают карточку и кнопку `tg://…`. Автозапуск через iframe
    // в разметке есть, но на десктопе выключен (`if (false)`, 2026-09-23),
    // поэтому закрываем только после клика: `handoff`. Лента `t.me/s/<канал>`
    // — это чтение в браузере, её не трогаем даже после клика.
    // WhatsApp и Discord рассмотрены и не взяты: кнопка «Open app» на
    // api.whatsapp.com уводит саму вкладку в веб-клиент, а Discord открывает
    // приглашение в приложении через локальный RPC, не по ссылке, и без входа
    // показывает форму регистрации.
    id: "telegram",
    optional: true,
    handoff: true,
    group: "apps",
    verified: false,
    title: "Telegram",
    match: ["https://t.me/*"],
    test: /^https:\/\/t\.me\/(?!s\/)[^/?#]/,
    defaultOn: false,
  },

  // ── Вход в CLI ─────────────────────────────────────────────────────────
  // Утилита открывает браузер для входа и после него оставляет страницу
  // «можно закрыть». Гейт — ровно путь этой страницы, остальной сайт
  // (документация Google Cloud, консоль Claude) не затрагивается.
  // Финиши на localhost (AWS, Azure, Firebase) не взяты: под тот же адрес
  // попал бы локальный сервер разработчика.
  {
    // cloud.google.com/sdk/auth_success редиректит сюда (301, 2026-09-23)
    id: "gcloud",
    optional: true,
    group: "cli",
    verified: false,
    title: "Google Cloud CLI",
    match: ["https://docs.cloud.google.com/sdk/auth_success*"],
    test: /^https:\/\/docs\.cloud\.google\.com\/sdk\/auth_success([/?#]|$)/,
    defaultOn: false,
  },
  {
    id: "wrangler",
    optional: true,
    group: "cli",
    verified: false,
    title: "Cloudflare Wrangler",
    match: ["https://welcome.developers.workers.dev/wrangler-oauth-consent-granted*"],
    test: /^https:\/\/welcome\.developers\.workers\.dev\/wrangler-oauth-consent-granted([/?#]|$)/,
    defaultOn: false,
  },
  {
    // console.anthropic.com/oauth/code/success редиректит сюда (301, 2026-09-23).
    // Соседняя /oauth/code/callback показывает код для ручной вставки — её
    // не трогаем: человек может ещё не скопировать код.
    id: "claude-code",
    optional: true,
    group: "cli",
    verified: false,
    title: "Claude Code",
    match: ["https://platform.claude.com/oauth/code/success*"],
    test: /^https:\/\/platform\.claude\.com\/oauth\/code\/success([/?#]|$)/,
    defaultOn: false,
  },
];

// VK Звонки сознательно не поддержаны: их адрес живёт на vk.com, а доступ
// к домену выдаётся браузером целиком, не только на /call/. Платить доступом
// ко всей соцсети за одну хвостовую вкладку — плохая сделка.

const REQUIRED_MATCHES = PLATFORMS.filter((p) => !p.optional).flatMap((p) => p.match);
const OPTIONAL_MATCHES = PLATFORMS.filter((p) => p.optional).flatMap((p) => p.match);
const ALL_MATCHES = [...REQUIRED_MATCHES, ...OPTIONAL_MATCHES];

// Общий для service worker (importScripts) и страницы настроек (<script>).
if (typeof self !== "undefined") {
  Object.assign(self, { PLATFORMS, REQUIRED_MATCHES, OPTIONAL_MATCHES, ALL_MATCHES });
}
