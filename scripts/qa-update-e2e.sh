#!/bin/bash
# CopyBoard (Tauri) — uygulama içi güncellemenin UÇTAN UCA yerel sınaması (macOS).
#
# GitHub'a hiçbir şey yüklemeden zinciri GERÇEK paketlerle koşturur:
#   eski sürüm (hata ayıklama derlemesi, `--qa-update`) → yerel latest.json →
#   yeni sürümü indir → minisign imzasını DOĞRULA → .app'i yerinde değiştir →
#   yeniden başla.
# Sonunda ölçer: yeni sürüm koşuyor ve ayakta kalıyor mu, paketin sürümü, kök izni
# (0755), imza gereksinimi değişmedi mi (izinler korunur), imza geçerli mi. Kendi
# oluşturduğu her şeyi siler.
#
# NEDEN AYRI AD VE KİMLİK: paketli uygulama her açılışta
# ~/Library/LaunchAgents/<ürün adı>.plist'i yeniden yazıyor ya da siliyor
# (lib.rs `sync_autostart`). `CopyBoard` adıyla açılan bir test kopyası kullanıcının
# oturum açma öğesini test yoluna çevirirdi. Ayrı kimlik de veri dizininin ve
# tek-örnek soketinin kurulu uygulamayla karışmamasını sağlıyor. Betik yine de
# CopyBoard.plist'i önce/sonra karşılaştırıyor.
#
# latest.json'ı yayın akışının KENDİ betiği (scripts/release-files.mjs) yazıyor;
# yalnız adresler yerel sunucuya çevriliyor. Böylece eklentinin o dosyayı
# okuyabildiği de sınanmış oluyor.
#
# Gerekenler: "CopyBoard Dev" imza kimliği (SIGNING.md §2), ~/.tauri/copyboard.key.
# Kullanım:  bash scripts/qa-update-e2e.sh
#   QAU_PORT=18765   yerel sunucunun portu
#   QAU_KEEP=1       çalışma klasörünü silme (hata ayıklamak için)

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NAME="CopyBoardUpdateTest"
ID="com.nurullahyayan.copyboard.updatetest"
PORT="${QAU_PORT:-18765}"
KEY="$HOME/.tauri/copyboard.key"
OLD_VER="$(node -p "require(process.argv[1]).version" "$REPO/src-tauri/tauri.conf.json")"
NEW_VER="$(node -p "const [a,b,c]=process.argv[1].split('.').map(Number); [a,b,c+1].join('.')" "$OLD_VER")"
DEBUG_APP="$REPO/src-tauri/target/debug/bundle/macos/$NAME.app"
REL_DIR="$REPO/src-tauri/target/release/bundle/macos"
DATA="$HOME/Library/Application Support/$ID"
APPLOG="$HOME/Library/Logs/$ID/copyboard.log"
USER_PLIST="$HOME/Library/LaunchAgents/CopyBoard.plist"
TEST_PLIST="$HOME/Library/LaunchAgents/$NAME.plist"
SOCKET="/tmp/$(printf '%s' "$ID" | tr '.-' '__')_si.sock"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cb-qa-update.XXXXXX")"
APP="$WORK/kurulu/$NAME.app"
PROC_PATTERN="cb-qa-update.*/$NAME.app/Contents/MacOS/"

FAILS=0
ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }
# Temizlik (EXIT tuzağı) çıkış kodunu FAILS'ten okuyor: die de saymalı, yoksa
# yarıda kalan koşu "0 başarısız" diye biterdi.
die()  { echo "✗ $*" >&2; FAILS=$((FAILS + 1)); exit 1; }
check() { if eval "$1"; then ok "$2"; else bad "$2"; fi; }

# ── Ön koşullar ──────────────────────────────────────────────────────────────
[ "$(uname)" = "Darwin" ] || die "yalnız macOS"
security find-identity -v -p codesigning 2>/dev/null | grep -qF '"CopyBoard Dev"' \
  || die "\"CopyBoard Dev\" imza kimliği yok (SIGNING.md §2)"
[ -f "$KEY" ] || die "güncelleyici anahtarı yok: $KEY (SIGNING.md §1)"
pgrep -f "$NAME.app/Contents/MacOS/" > /dev/null && die "$NAME zaten çalışıyor — önceki koşudan kalmış olabilir"
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1 && die "port $PORT dolu (QAU_PORT ile değiştir)"

USER_PLIST_SUM=""
if [ -f "$USER_PLIST" ]; then
  cp "$USER_PLIST" "$WORK/CopyBoard.plist.yedek"
  USER_PLIST_SUM="$(shasum -a 256 "$USER_PLIST" | cut -d' ' -f1)"
fi

SRV_PID=""
cleanup() {
  echo "── Temizlik"
  pkill -f "$PROC_PATTERN" 2>/dev/null
  for _ in 1 2 3 4 5; do pgrep -f "$PROC_PATTERN" > /dev/null || break; sleep 1; done
  pkill -9 -f "$PROC_PATTERN" 2>/dev/null
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  # Yalnız TEST kimliğine ait olanlar — kurulu CopyBoard'unkilere dokunulmuyor.
  defaults delete "$ID" > /dev/null 2>&1
  rm -rf "$DATA" "$HOME/Library/Logs/$ID" "$HOME/Library/Caches/$ID" "$HOME/Library/WebKit/$ID" \
    "$HOME/Library/HTTPStorages/$ID" "$HOME/Library/HTTPStorages/$ID.binarycookies" \
    "$HOME/Library/Saved Application State/$ID.savedState"
  rm -f "$TEST_PLIST" "$SOCKET"
  rm -rf "$DEBUG_APP" "$REL_DIR/$NAME.app" "$REL_DIR/$NAME.app.tar.gz" "$REL_DIR/$NAME.app.tar.gz.sig"
  if [ -n "$USER_PLIST_SUM" ]; then
    if [ "$(shasum -a 256 "$USER_PLIST" 2>/dev/null | cut -d' ' -f1)" != "$USER_PLIST_SUM" ]; then
      cp "$WORK/CopyBoard.plist.yedek" "$USER_PLIST"
      echo "  ✗ CopyBoard.plist DEĞİŞMİŞTİ — yedekten geri yüklendi"
      FAILS=$((FAILS + 1))
    else
      echo "  ✓ kurulu uygulamanın oturum açma öğesi (CopyBoard.plist) değişmedi"
    fi
  fi
  if [ "${QAU_KEEP:-}" = "1" ]; then echo "  çalışma klasörü korundu: $WORK"; else rm -rf "$WORK"; fi
  echo "QAU SONUÇ: $FAILS başarısız"
  [ "$FAILS" -eq 0 ]
}
trap 'cleanup; exit $?' EXIT
trap 'exit 130' INT TERM

echo "CopyBoard güncelleme sınaması: $OLD_VER → $NEW_VER (port $PORT)"

# Önceki yarım bir koşunun izleri (yalnız test kimliği).
rm -rf "$DATA" "$HOME/Library/Logs/$ID"; rm -f "$TEST_PLIST" "$SOCKET"

# ── 1. Paketler ──────────────────────────────────────────────────────────────
updater_cfg='"plugins":{"updater":{"endpoints":["http://127.0.0.1:'"$PORT"'/latest.json"],"dangerousInsecureTransportProtocol":true}}'
printf '{"productName":"%s","identifier":"%s",%s}\n' "$NAME" "$ID" "$updater_cfg" > "$WORK/eski.json"
printf '{"productName":"%s","identifier":"%s","version":"%s","bundle":{"createUpdaterArtifacts":true},%s}\n' \
  "$NAME" "$ID" "$NEW_VER" "$updater_cfg" > "$WORK/yeni.json"

echo "── 1. Derleme (eski: debug + --qa-update, yeni: release + güncelleme imzası)"
cd "$REPO" || die "depo yok"
APPLE_SIGNING_IDENTITY="CopyBoard Dev" npx tauri build --debug --bundles app --config "$WORK/eski.json" \
  > "$WORK/derle-eski.log" 2>&1 || { tail -20 "$WORK/derle-eski.log"; die "eski paket derlenemedi"; }
# Anahtarın İÇERİĞİ değil YOLU veriliyor: içerik süreç ortamında görünmesin.
APPLE_SIGNING_IDENTITY="CopyBoard Dev" TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  npx tauri build --bundles app --config "$WORK/yeni.json" \
  > "$WORK/derle-yeni.log" 2>&1 || { tail -20 "$WORK/derle-yeni.log"; die "yeni paket derlenemedi"; }
[ -f "$REL_DIR/$NAME.app.tar.gz.sig" ] || die "güncelleme imzası (.sig) üretilmedi"
ok "paketler hazır"

# ── 2. latest.json — yayın akışının kendi betiğiyle ──────────────────────────
echo "── 2. latest.json (scripts/release-files.mjs)"
mkdir -p "$WORK/indirilen/nsis" "$WORK/calisma"
cp "$REL_DIR/$NAME.app.tar.gz" "$REL_DIR/$NAME.app.tar.gz.sig" "$WORK/indirilen/"
: > "$WORK/indirilen/${NAME}_${NEW_VER}_aarch64.dmg"            # betik DMG'nin varlığını istiyor
: > "$WORK/indirilen/nsis/${NAME}_${NEW_VER}_x64-setup.exe"     # Windows sahtesi; macOS kullanmıyor
printf 'c2FodGU=' > "$WORK/indirilen/nsis/${NAME}_${NEW_VER}_x64-setup.exe.sig"
printf '# CopyBoard v%s Release Notes\n\nYerel güncelleme sınaması.\n\n---\n' "$NEW_VER" > "$WORK/calisma/CHANGELOG.md"
(cd "$WORK/calisma" && GITHUB_REPOSITORY=NYAYAN/CopyBoard \
  node "$REPO/scripts/release-files.mjs" ../indirilen ../paketler "tauri-v$NEW_VER" ../notlar.md) \
  > "$WORK/release-files.log" 2>&1 || { cat "$WORK/release-files.log"; die "release-files.mjs başarısız"; }
sed -i '' "s#https://github.com/NYAYAN/CopyBoard/releases/download/tauri-v$NEW_VER/#http://127.0.0.1:$PORT/#g" \
  "$WORK/paketler/latest.json"
check "node -e '
  const m = require(process.argv[1]); const sig = require(\"fs\").readFileSync(process.argv[2], \"utf8\").trim();
  const e = m.platforms[\"darwin-aarch64-app\"];
  process.exit(m.version === process.argv[3] && e && e.signature === sig && e.url.startsWith(\"http://127.0.0.1\") ? 0 : 1)
' '$WORK/paketler/latest.json' '$REL_DIR/$NAME.app.tar.gz.sig' '$NEW_VER'" \
  "latest.json: sürüm $NEW_VER, darwin-aarch64-app imzası .sig ile aynı"

# ── 3. Yerel sunucu ──────────────────────────────────────────────────────────
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$WORK/paketler" > "$WORK/sunucu.log" 2>&1 &
SRV_PID=$!
# Yoklama `/`'a: `/latest.json`'a gitseydi sunucu günlüğündeki "uygulama latest.json'ı
# çekti" ölçümü kendiliğinden geçerdi.
for _ in $(seq 1 20); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.25; done
curl -fs -o /dev/null "http://127.0.0.1:$PORT/" || die "yerel sunucu açılmadı"

# ── 4. Eski sürümü "kur" ve başlat ───────────────────────────────────────────
echo "── 3. Eski sürüm ($OLD_VER) başlatılıyor"
mkdir -p "$WORK/kurulu"
ditto "$DEBUG_APP" "$APP"
DR_BEFORE="$(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')"
# Taze veri dizini ilk açılışta Electron verisini KOPYALIYOR (migrate.rs). Boş bir
# config.json göçü atlatıyor: test kopyası kullanıcının geçmişini hiç okumasın.
mkdir -p "$DATA"; printf '{}' > "$DATA/config.json"
open -n --stdout "$WORK/kosu.out" --stderr "$WORK/kosu.err" "$APP" --args --hidden --qa-update

OLD_PID=""
for _ in $(seq 1 40); do OLD_PID="$(pgrep -f "$PROC_PATTERN" | head -1)"; [ -n "$OLD_PID" ] && break; sleep 0.25; done
[ -n "$OLD_PID" ] || die "eski sürüm başlamadı"

# ── 5. Güncelleme + yeniden başlatma bekleniyor ──────────────────────────────
echo "── 4. İndir → doğrula → kur → yeniden başlat bekleniyor"
NEW_SEEN=""
for _ in $(seq 1 90); do
  grep -q "QAU SONUC" "$WORK/kosu.out" 2>/dev/null && break
  grep -q "sürüm $NEW_VER · binary" "$APPLOG" 2>/dev/null && { NEW_SEEN=1; break; }
  sleep 1
done
[ -f "$WORK/kosu.out" ] && grep "QAU SONUC" "$WORK/kosu.out" | sed 's/^/  /'

echo "── 5. Ölçüm"
check "grep -q 'QA-UPDATE başlıyor: kurulu sürüm $OLD_VER' '$APPLOG'" "eski sürüm ($OLD_VER) güncellemeyi buldu"
check "grep -q 'QA-UPDATE: indirildi ve imza doğrulandı' '$APPLOG'" "paket indirildi ve minisign imzası doğrulandı"
check "grep -q 'güncelleme kuruldu — yeni sürümle yeniden başlatılıyor' '$APPLOG'" "paket yerinde değişti, yeniden başlatma istendi"
check "[ -n '$NEW_SEEN' ]" "yeni sürüm ($NEW_VER) açıldı"
sleep 4   # tek-örnek yarışı: yeni süreç "zaten açık" deyip hemen çıksaydı burada görünürdü
NEW_PIDS="$(pgrep -f "$PROC_PATTERN" | tr '\n' ' ')"
check "[ \"\$(echo $NEW_PIDS | wc -w | tr -d ' ')\" = 1 ] && ! echo ' $NEW_PIDS' | grep -qw '$OLD_PID'" \
  "yeni sürüm ayakta, tek süreç ve eski süreç değil (eski $OLD_PID, şimdi ${NEW_PIDS:-yok})"
check "[ \"\$(defaults read '$APP/Contents/Info.plist' CFBundleShortVersionString)\" = '$NEW_VER' ]" \
  "paket sürümü $NEW_VER"
# Eklenti yeni paketi bir `tempfile` dizinine (0700) açıp o dizini paketin yerine
# koyuyor. 2.13.2'den beri kökü kendisi 0755 yapıyor: arşivin kök girdisi 0700'e
# çevrilip yeniden imzalandığında da 755 ölçüldü. 2.10.1'de bunu yalnız arşivin ilk
# girdisi (`X.app/`, drwxr-xr-x) sağlıyordu. Eklenti ya da paketleme değişirse uygulama
# yalnız sahibine açık kalabilir — bekçi bu.
check "[ \"\$(stat -f %Lp '$APP')\" = 755 ]" "paket kökü 0755 (şimdi $(stat -f %Lp "$APP"))"
DR_AFTER="$(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')"
check "[ -n \"\$DR_BEFORE\" ] && [ \"\$DR_BEFORE\" = \"\$DR_AFTER\" ] && echo \"\$DR_AFTER\" | grep -q 'certificate leaf'" \
  "imza gereksinimi aynı ve sertifikaya bağlı (izinler korunur)"
check "codesign --verify --deep --strict '$APP' 2>/dev/null" "yeni paketin imzası geçerli"
check "grep -q 'GET /latest.json' '$WORK/sunucu.log' && grep -q 'GET /${NAME}_${NEW_VER}_aarch64.app.tar.gz' '$WORK/sunucu.log'" \
  "uygulama latest.json'ı ve paketi yerel sunucudan çekti"
# Günlük temizlikte siliniyor; zincirin izi (hangi sürüm hangi yoldan açıldı) burada kalsın.
echo "── Güncelleyici günlüğü"
grep -E '\[updater\]|QA-UPDATE|sürüm [0-9.]+ · binary' "$APPLOG" 2>/dev/null | sed -E 's/^.*\]\[[^]]*\]\[[^]]*\] //; s/^/  /'
if [ "$FAILS" -gt 0 ]; then
  echo "── Uygulama günlüğü (son 25 satır)"; tail -25 "$APPLOG" 2>/dev/null | sed 's/^/  /'
fi
