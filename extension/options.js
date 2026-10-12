// Страница настроек. Тексты приходят из _locales, список платформ —
// из platforms.js, поэтому добавление ВКС не требует правок здесь.
//
// Отдельная забота: платформы с `optional: true`. Разрешение на их домены
// не просится при установке, поэтому галочка тут не просто пишет настройку,
// а запрашивает доступ у браузера. Пока доступа нет, включённой настройке
// верить нельзя — источник правды это chrome.permissions, и галочка
// отражает именно его.

const t = (key) => chrome.i18n.getMessage(key);

// Код локали, из которой браузер взял строки: своя у пользователя есть
// только для ru и en, остальные получают английскую (default_locale). По нему
// же пишутся названия платформ — кириллицей только в русской локали, иначе
// англоязычный интерфейс пестрел бы «Телемостом» и «Толком».
const locale = t("locale") || "en";
const platformTitle = (p) => (locale === "ru" ? p.title : p.titleEn ?? p.title);

document.documentElement.lang = locale;
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);

// Встречи группируем по тому, нужен ли платформе отдельный доступ;
// мессенджеры и вход в CLI — отдельными разделами (`group` в реестре),
// доступ к сайту им нужен всегда.
const lists = Object.fromEntries(
  ["ready", "optional", "apps", "cli"].map((id) => [id, document.getElementById(id)]),
);
const listFor = (platform) => platform.group ?? (platform.optional ? "optional" : "ready");
const delaySelect = document.getElementById("delay");
const savedTag = document.getElementById("saved");

// Платформа, доступ к сайту которой только что не выдали: сообщение об этом
// показываем под её галочкой, а не в конце страницы.
let denied = null;

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

// Флажки платформ лежат одним объектом, и запись — это read-modify-write.
// Две галочки, нажатые подряд быстрее, чем отвечает storage, иначе прочли бы
// одно и то же и вторая затёрла бы первую. Пишем строго по очереди.
let saving = Promise.resolve();
function setEnabled(id, value) {
  saving = saving.catch(() => {}).then(async () => {
    const { enabled = {} } = await chrome.storage.sync.get("enabled");
    await chrome.storage.sync.set({ enabled: { ...enabled, [id]: value } });
    flashSaved();
  });
  return saving;
}

// Запрос разрешения обязан идти прямо из обработчика клика, иначе браузер
// сочтёт его не пользовательским и молча откажет. Поэтому здесь никаких
// await до самого chrome.permissions.request.
async function onToggle(platform, box) {
  denied = null;

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
      denied = platform.id;
      return;
    }
    await setEnabled(platform.id, true);
  } else {
    await setEnabled(platform.id, false);
    await chrome.permissions.remove({ origins: platform.match });
  }
}

function rowFor(platform, checked, granted) {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.dataset.id = platform.id;
  box.checked = checked;
  box.addEventListener("change", () => onToggle(platform, box).then(render));

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = platformTitle(platform);

  const label = document.createElement("label");
  label.className = "row";
  label.append(box, title);
  if (!granted) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = t("optionsNeedsPermission");
    label.append(badge);
  }

  const li = document.createElement("li");
  li.append(label);
  if (denied === platform.id) {
    const error = document.createElement("p");
    error.className = "row-error";
    error.setAttribute("role", "alert");
    error.textContent = t("optionsPermissionDenied");
    li.append(error);
  }
  return li;
}

async function render() {
  const [{ enabled = {}, delaySeconds }, { closed = 0 }, granted] = await Promise.all([
    chrome.storage.sync.get(["enabled", "delaySeconds"]),
    chrome.storage.local.get("closed"),
    Promise.all(PLATFORMS.map(hasPermission)),
  ]);

  // Список перерисовывается целиком, и нажатая галочка — новый элемент.
  // Возвращаем на неё фокус, иначе с клавиатуры после каждого нажатия
  // приходилось бы начинать обход страницы заново.
  const focused = document.activeElement?.dataset.id;

  const rows = Object.fromEntries(Object.keys(lists).map((id) => [id, []]));
  PLATFORMS.forEach((platform, i) => {
    const checked = (enabled[platform.id] ?? platform.defaultOn) && granted[i];
    rows[listFor(platform)].push(rowFor(platform, checked, granted[i]));
  });
  for (const [id, list] of Object.entries(lists)) list.replaceChildren(...rows[id]);
  if (focused) document.querySelector(`input[data-id="${focused}"]`)?.focus();

  delaySelect.value = String(effectiveDelay(delaySeconds));
  document.getElementById("closed").textContent = String(closed);
}

delaySelect.addEventListener("change", async () => {
  await chrome.storage.sync.set({ delaySeconds: Number(delaySelect.value) });
  flashSaved();
});

render();
