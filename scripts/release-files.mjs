#!/usr/bin/env node
// CopyBoard (Tauri) — Actions'ın indirdiği paketlerden GitHub Release'e yüklenecek
// dosyaları hazırlar: düz bir klasör + (imzalıysa) `latest.json` + sürüm notu.
//
// NTerminal'in `scripts/release-files.mjs`inden uyarlandı; oradaki dersler aynen geçerli.
//
// NEDEN DÜZ KLASÖR: Windows işinin paketleri `nsis/` alt klasöründe geliyor
// (upload-artifact birden çok yolu ortak atalarına göre saklıyor). `gh release create
// … paketler/*` klasörü dosya sanıp yüklemeye çalışınca taslağı silip çıkıyor
// (NTerminal v0.2.1 hiç yayımlanmadı). Burada yalnız DOSYA kopyalanıyor ve beklenen
// her paketin yerinde olduğu denetleniyor.
//
// NEDEN `latest.json`: uygulamanın içinden güncelleme (tauri-plugin-updater) bu dosyayı
// okuyor: sürüm, her platform + kurucu türü için paketin adresi ve imzası. İmzalar CI'da
// `TAURI_SIGNING_PRIVATE_KEY` ile üretiliyor; imza yoksa dosya YAZILMIYOR ve uygulama
// bu sürümü kendisi kuramıyor.
//
// `latest.json` İKİ YERE gidiyor: sürümün kendi release'i (iz için) ve sabit
// `tauri-updater` ön sürümü (uygulamanın okuduğu adres, bkz. tauri.conf.json). Sebebi
// bu repoda Electron release'lerinin de yaşaması: Tauri release'leri ÖN SÜRÜM olarak
// yayınlanıyor ki GitHub'ın "Latest"i — dolayısıyla Electron'un electron-updater'ı —
// onları hiç görmesin. `releases/latest/download/…` bu yüzden kullanılamıyor.
//
// Anahtarlar YALNIZ kurucu türüyle (`windows-x86_64-nsis`, `darwin-aarch64-app`): türü
// bilinmeyen bir kopya genel `windows-x86_64` anahtarına düşüp yanlış kurucuyla
// "güncellenmesin" — o anahtar bilerek yok.
//
// SÜRÜM NOTU: `CHANGELOG.md`'deki `# CopyBoard v<sürüm> Release Notes` bölümü hem
// `latest.json`'ın `notes`'una (güncelleme diyaloğu gösteriyor) hem release gövdesine
// gidiyor. Bölüm yoksa yayın DURUYOR: 3.1.0 notsuz çıkmıştı ve kullanıcı güncelleme
// diyaloğunda neyin değiştiğini göremezdi.
//
// TÜM SÜRÜMLER: `latest.json`'ın `changelog`'u CHANGELOG'daki her sürüm bölümünü taşıyor
// (`[{version, notes}]`, en yeniden eskiye; etiketlenen sürümden yenisi dahil değil).
// Diyaloğun "Tüm sürüm notları" penceresi ve "bu güncelleme N sürümü kapsıyor" bilgisi
// buradan — ek bir istek yok, güncelleme kontrolü zaten bu dosyayı indiriyor. Eklenti
// bilinmeyen alanı yok sayıyor; uygulama `Update::raw_json`'dan okuyor.
//
// Kullanım:
//   node scripts/release-files.mjs <indirilen> <çıkış> <etiket> <not-dosyası>
//   (depo adı GITHUB_REPOSITORY'den; yoksa NYAYAN/CopyBoard)

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [source, out, tag, notesOut] = process.argv.slice(2);
if (!source || !out || !tag || !notesOut) {
  console.error("kullanım: node scripts/release-files.mjs <indirilen> <çıkış> <etiket> <not-dosyası>");
  process.exit(2);
}
const repo = process.env.GITHUB_REPOSITORY || "NYAYAN/CopyBoard";
const tagMatch = /^tauri-v(\d+\.\d+\.\d+)$/.exec(tag);
if (!tagMatch) {
  console.error(`::error::Etiket '${tag}' Tauri biçiminde değil (beklenen: tauri-vX.Y.Z).`);
  process.exit(1);
}
const version = tagMatch[1];

/** Klasördeki bütün dosyalar, alt klasörler dahil. */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Paket adındaki mimari → updater'ın adı (`x64` → `x86_64`). */
function archOf(name) {
  if (/_universal\.dmg$/.test(name)) return ["x86_64", "aarch64"];
  if (/_(aarch64|arm64)[-_.]/.test(name)) return ["aarch64"];
  if (/_(x64|x86_64)[-_.]/.test(name)) return ["x86_64"];
  return null;
}

/** CHANGELOG.md'den bu sürümün bölümü: başlıktan sonraki satırlar, `---`ya ya da bir
 *  sonraki sürüm başlığına kadar. */
function releaseNotes(ver) {
  const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `# CopyBoard v${ver} Release Notes`);
  if (start < 0) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "---" || /^# CopyBoard v/.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text || null;
}

/** "3.2.1" karşılaştırması: <0, 0, >0. */
function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** CHANGELOG.md'deki TÜM sürüm bölümleri, en yeniden eskiye; boş bölümler atlanır. */
function changelogEntries(upTo) {
  const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
  const entries = [];
  let current = null;
  for (const line of lines) {
    const m = /^# CopyBoard v(\d+\.\d+\.\d+) Release Notes$/.exec(line.trim());
    if (m) {
      current = { version: m[1], body: [], done: false };
      entries.push(current);
    } else if (current && !current.done) {
      if (line.trim() === "---") current.done = true;
      else current.body.push(line);
    }
  }
  return entries
    .map((e) => ({ version: e.version, notes: e.body.join("\n").trim() }))
    .filter((e) => e.notes && compareVersions(e.version, upTo) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

const files = existsSync(source) ? walk(source) : [];
const pick = (test) => files.filter((f) => test(basename(f)));
const kinds = {
  nsis: pick((n) => n.endsWith("-setup.exe")),
  dmg: pick((n) => n.endsWith(".dmg")),
  app: pick((n) => n.endsWith(".app.tar.gz")),
};

const problems = [];
for (const kind of ["nsis", "dmg"]) {
  if (kinds[kind].length === 0) problems.push(`${kind} paketi yok`);
}
for (const [kind, list] of Object.entries(kinds)) {
  if (list.length > 1) problems.push(`birden çok ${kind} paketi: ${list.map((f) => basename(f)).join(", ")}`);
}

const notes = releaseNotes(version);
if (!notes) problems.push(`CHANGELOG.md'de '# CopyBoard v${version} Release Notes' bölümü yok`);

const signatureOf = (file) => (existsSync(`${file}.sig`) ? readFileSync(`${file}.sig`, "utf8").trim() : null);
const updaterFiles = [kinds.nsis[0], kinds.app[0]].filter(Boolean);
const signed = updaterFiles.filter((f) => signatureOf(f));
// İmzanın hepsi ya da hiçbiri: anahtar aynı sır, iki platformda aynı anda var ya da
// yok. Yarım imza bir yol kayması demek ve sessizce yarım bir latest.json yayımlamak
// bir platformu güncellemesiz bırakırdı.
const withUpdater = signed.length > 0;
if (withUpdater) {
  if (!kinds.app[0]) problems.push("imzalı paketler var ama macOS güncelleme paketi (.app.tar.gz) yok");
  for (const file of updaterFiles) {
    if (!signatureOf(file)) problems.push(`imzası yok: ${basename(file)}`);
  }
}

const dmgArch = kinds.dmg[0] ? archOf(basename(kinds.dmg[0])) : null;
if (withUpdater && !dmgArch) problems.push(`macOS mimarisi okunamadı: ${basename(kinds.dmg[0] ?? "")}`);

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(notesOut, `${notes}\n`);
const published = [];
const publish = (file, name = basename(file)) => {
  copyFileSync(file, join(out, name));
  published.push(name);
  return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
};

const nsisUrl = publish(kinds.nsis[0]);
publish(kinds.dmg[0]);

if (withUpdater) {
  // Tauri macOS paketini sürümsüz adlandırıyor (`CopyBoard.app.tar.gz`); Release
  // sayfasında DMG'nin yanında neyin ne olduğu okunsun.
  const appName = basename(kinds.app[0]).replace(/\.app\.tar\.gz$/, `_${version}_${dmgArch.join("-")}.app.tar.gz`);
  const appUrl = publish(kinds.app[0], appName);

  const platforms = {};
  const entry = (file, url) => ({ signature: signatureOf(file), url });
  for (const arch of archOf(basename(kinds.nsis[0])) ?? ["x86_64"]) {
    platforms[`windows-${arch}-nsis`] = entry(kinds.nsis[0], nsisUrl);
  }
  for (const arch of dmgArch) {
    platforms[`darwin-${arch}-app`] = entry(kinds.app[0], appUrl);
  }
  const changelog = changelogEntries(version);
  const manifest = { version, notes, pub_date: new Date().toISOString(), platforms, changelog };
  writeFileSync(join(out, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  published.push("latest.json");
  console.log(`latest.json: ${Object.keys(platforms).join(", ")} · changelog ${changelog.length} sürüm`);
} else {
  console.log(
    "::warning::Paketler imzasız (TAURI_SIGNING_PRIVATE_KEY tanımlı değil): latest.json yazılmadı, " +
      "uygulama bu sürümü kendisi kuramayacak.",
  );
}

console.log(`Release dosyaları (${published.length}): ${published.join(", ")}`);
