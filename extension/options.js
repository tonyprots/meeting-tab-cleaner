// Страница настроек. Тексты приходят из _locales, список платформ —
// из platforms.js, поэтому добавление ВКС не требует правок здесь.
//
// Отдельная забота: платформы с `optional: true`. Разрешение на их домены
// не просится при установке, поэтому галочка тут не просто пишет настройку,
// а запрашивает доступ у браузера. Пока доступа нет, включённой настройке
// верить нельзя — источник правды это chrome.permissions, и галочка
// отражает именно его.

const DEFAULT_DELAY = 30;
const t = (key) => chrome.i18n.getMessage(key);
// Названия платформ живут в реестре по-русски; для любой другой локали
// браузера берём латинское имя, если оно там задано (Телемост, Толк,
// МТС Линк, Джаз), — иначе английский пользователь видит кириллицу.
const isRu = chrome.i18n.getUILanguage().toLowerCase().startsWith("ru");
const platformTitle = (p) => (isRu ? p.title : p.titleEn ?? p.title);

for (const [id, key] of [
  ["t-title", "optionsTitle"],
  ["t-subtitle", "optionsSubtitle"],
  ["t-group-ready", "optionsGroupReady"],
  ["t-group-ready-hint", "optionsGroupReadyHint"],
  ["t-group-optional", "optionsGroupOptional"],
  ["t-group-optional-hint", "optionsGroupOptionalHint"],
  ["t-delay-head", "optionsDelay"],
  ["t-delay", "optionsDelay"],
  ["t-seconds", "optionsSeconds"],
  ["t-safety", "optionsSafety"],
  ["t-stats", "optionsStats"],
  ["saved", "optionsSaved"],
  ["error", "optionsPermissionDenied"],
]) {
  document.getElementById(id).textContent = t(key);
}

// Группируем по тому, нужен ли платформе отдельный доступ, — это
// единственное, чем они теперь друг от друга отличаются.
const lists = {
  ready: document.getElementById("ready"),
  optional: document.getElementById("optional"),
};
const delaySelect = document.getElementById("delay");
const savedTag = document.getElementById("saved");
const errorTag = document.getElementById("error");

let savedTimer;
function flashSaved() {
  savedTag.classList.add("on");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedTag.classList.remove("on"), 1200);
}

const hasPermission = (platform) =>
  platform.optional
    ? chrome.permissions.contains({ origins: platform.match })
    : Promise.resolve(true);

async function setEnabled(id, value) {
  const { enabled = {} } = await chrome.storage.sync.get("enabled");
  await chrome.storage.sync.set({ enabled: { ...enabled, [id]: value } });
  flashSaved();
}

// Запрос разрешения обязан идти прямо из обработчика клика, иначе браузер
// сочтёт его не пользовательским и молча откажет. Поэтому здесь никаких
// await до самого chrome.permissions.request.
async function onToggle(platform, box) {
  errorTag.classList.remove("on");

  if (!platform.optional) {
    await setEnabled(platform.id, box.checked);
    return;
  }

  if (box.checked) {
    // Отказ и ошибка запроса (например, вызов без жеста пользователя)
    // для нас одно и то же: доступа нет, галочку не ставим.
    const granted = await chrome.permissions
      .request({ origins: platform.match })
      .catch(() => false);
    if (!granted) {
      box.checked = false;
      errorTag.classList.add("on");
      return;
    }
    await setEnabled(platform.id, true);
  } else {
    await setEnabled(platform.id, false);
    await chrome.permissions.remove({ origins: platform.match });
  }
}

function badgeFor(platform, granted) {
  const badge = document.createElement("span");
  if (platform.optional && !granted) {
    badge.className = "badge ask";
    badge.textContent = t("optionsNeedsPermission");
  } else {
    badge.className = platform.verified ? "badge ok" : "badge";
    badge.textContent = t(platform.verified ? "optionsVerified" : "optionsUnverified");
  }
  return badge;
}

async function render() {
  const { enabled = {}, delaySeconds } = await chrome.storage.sync.get([
    "enabled",
    "delaySeconds",
  ]);
  const { closed = 0 } = await chrome.storage.local.get("closed");

  const rows = { ready: [], optional: [] };
  for (const platform of PLATFORMS) {
    const granted = await hasPermission(platform);

    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.id = platform.id;
    box.checked = (enabled[platform.id] ?? platform.defaultOn) && granted;
    box.addEventListener("change", () => onToggle(platform, box).then(render));

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = platformTitle(platform);

    const label = document.createElement("label");
    label.className = "row";
    label.append(box, title, badgeFor(platform, granted));

    const li = document.createElement("li");
    li.append(label);
    rows[platform.optional ? "optional" : "ready"].push(li);
  }

  lists.ready.replaceChildren(...rows.ready);
  lists.optional.replaceChildren(...rows.optional);

  delaySelect.value = String(delaySeconds || DEFAULT_DELAY);
  document.getElementById("closed").textContent = String(closed);
}

delaySelect.addEventListener("change", async () => {
  await chrome.storage.sync.set({ delaySeconds: Number(delaySelect.value) });
  flashSaved();
});

render();
