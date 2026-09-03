// Сборка ZIP для загрузки в Chrome Web Store.
// Запуск: node store/build.mjs  →  store/dist/meeting-tab-cleaner-<версия>.zip
//
// Перед сборкой прогоняет оба теста и падает, если хоть один красный:
// выложить в стор сломанную сборку дороже, чем подождать минуту.
// Стор требует manifest.json в КОРНЕ архива, поэтому zip запускается изнутри
// extension/, а не над папкой.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(root, "extension");
const DIST = path.join(root, "store", "dist");

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });

const skipTests = process.argv.includes("--skip-tests");
if (!skipTests) {
  console.log("→ смоук-тест");
  run("node", ["test/smoke.mjs"], { stdio: ["ignore", "ignore", "inherit"] });
  console.log("→ проверка загрузки в браузере");
  run("node", ["test/load-check.mjs"], { stdio: ["ignore", "ignore", "inherit"] });
}

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const zipName = `meeting-tab-cleaner-${manifest.version}.zip`;
const zipPath = path.join(DIST, zipName);

fs.mkdirSync(DIST, { recursive: true });
// Оставляем в dist ровно одну сборку: две версии рядом — верный способ
// однажды залить в стор не ту.
for (const f of fs.readdirSync(DIST)) {
  if (f.endsWith(".zip")) fs.rmSync(path.join(DIST, f));
}

// -x исключает мусор macOS: .DS_Store внутри архива — верный способ получить
// вопрос от ревью и лишний файл в чужом браузере.
run("zip", ["-r", "-q", "-X", zipPath, ".", "-x", ".*", "-x", "__MACOSX/*", "-x", "*/.DS_Store"], {
  cwd: EXT,
});

const listed = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
  .trim().split("\n").sort();

const required = [
  "manifest.json", "background.js", "content.js", "platforms.js", "rtc-probe.js",
  "options.html", "options.js",
  "_locales/ru/messages.json", "_locales/en/messages.json",
  "icons/icon16.png", "icons/icon48.png", "icons/icon128.png",
];
const missing = required.filter((f) => !listed.includes(f));
if (missing.length) {
  console.error("\nв архиве не хватает файлов:", missing.join(", "));
  process.exit(1);
}
const junk = listed.filter((f) => /(^|\/)\.|\.DS_Store$/.test(f));
if (junk.length) {
  console.error("\nв архиве мусор:", junk.join(", "));
  process.exit(1);
}

const kb = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`\n✓ ${path.relative(root, zipPath)} — ${kb} КБ, ${listed.length} файлов`);
console.log(`  версия ${manifest.version}`);
