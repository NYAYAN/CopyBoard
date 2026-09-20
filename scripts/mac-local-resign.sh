#!/bin/bash
# Yeni bir DMG'yi /Applications'a kopyaladıktan SONRA bir kez çalıştırın.
#
# İki şeyi birden halleder:
#   1. Gatekeeper karantinası (indirilen her dosyaya konur) kaldırılır.
#   2. Uygulama SABİT bir yerel kimlikle yeniden imzalanır.
#
# İkincisi asıl mesele. Dağıtılan derleme ad-hoc imzalı, yani designated
# requirement'ı "cdhash H'...'" — uygulamanın kimliği kodunun hash'i. Kod her
# sürümde değiştiği için macOS her güncellemeyi BAŞKA bir uygulama sayıyor ve
# Ekran Kaydı / Erişilebilirlik izinleri sıfırlanıyor. Sabit bir sertifikayla
# imzalayınca requirement "identifier ... and certificate leaf = H'...'" oluyor:
# koda değil, sertifikaya bağlı. Aynı sertifika durdukça izinler güncellemeler
# arasında korunuyor.
#
# NOT: Bunu ilk kez çalıştırdıktan sonra izni BİR KEZ daha vermeniz gerekir
# (kimlik cdhash'ten sertifikaya geçiyor). Sonraki güncellemelerde gerekmez.
#
# Bu yerel bir çözüm: sertifika yalnızca bu makinede var. Uygulamayı indiren
# başkalarının aynı sorunu yaşamaması için Apple Developer ID + notarization
# gerekir (bkz. SIGNING.md).
set -euo pipefail

APP="${1:-/Applications/CopyBoard.app}"
IDENTITY="${CB_SIGN_IDENTITY:-CopyBoard Dev}"

if [ ! -d "$APP" ]; then
    echo "✕ Uygulama bulunamadı: $APP" >&2
    exit 1
fi

# Bundle id SABİT YAZILMAZ — uygulamanın KENDİ Info.plist'inden okunur.
# Önce Electron'un id'si (com.nurullahyayan.copyboard) sabit yazılıydı. Tauri
# sürümü ayrı bir id kullanıyor (…copyboard.tauri); sabit id ile Tauri .app'i
# imzalanırsa imzanın kimliği Info.plist ile ÇELİŞİR ve TCC izinleri (Ekran
# Kaydı) sessizce bozulur. Artık hangi uygulamaya verilirse ona kendi id'siyle
# imza atılıyor; gerekirse CB_BUNDLE_ID ile elle geçilebilir.
BUNDLE_ID="${CB_BUNDLE_ID:-$(defaults read "$APP/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)}"
if [ -z "$BUNDLE_ID" ]; then
    echo "✕ $APP içinden CFBundleIdentifier okunamadı." >&2
    echo "  Elle vermek için: CB_BUNDLE_ID=<id> $0 \"$APP\"" >&2
    exit 1
fi
echo "→ Hedef: $APP  (bundle id: $BUNDLE_ID)"

if ! security find-identity -v -p codesigning | grep -q "\"$IDENTITY\""; then
    echo "✕ '$IDENTITY' adında bir kod imzalama sertifikası yok." >&2
    echo "  Keychain Access → Certificate Assistant → Create a Certificate…" >&2
    echo "  Ad: $IDENTITY · Identity Type: Self Signed Root · Certificate Type: Code Signing" >&2
    exit 1
fi

echo "→ Karantina kaldırılıyor"
xattr -rd com.apple.quarantine "$APP" 2>/dev/null || sudo xattr -rd com.apple.quarantine "$APP"

echo "→ '$IDENTITY' ile imzalanıyor"
# Önce içeriden dışarı (helper'lar, framework'ler), sonra dış kabuk tek başına:
# ikinci adım olmazsa üst seviye tanımlayıcı ikili dosyanın adını alıyor.
codesign --force --deep --sign "$IDENTITY" "$APP" 2>&1 | sed 's/^/   /'
codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" "$APP" 2>&1 | sed 's/^/   /'

echo "→ Doğrulanıyor"
codesign --verify --verbose=1 "$APP" 2>&1 | sed 's/^/   /'
DR=$(codesign -d -r- "$APP" 2>&1 | grep '^designated' || true)
echo "   $DR"

if echo "$DR" | grep -q 'cdhash'; then
    echo "✕ Requirement hâlâ cdhash'e bağlı — izinler yine sıfırlanacak." >&2
    exit 1
fi

# İmzanın kimliği gerçekten Info.plist'le aynı mı? Ayrışarsa macOS uygulamayı
# tanıyamaz ve izinler bozulur; sessiz bırakma.
SIGNED_ID=$(codesign -dv "$APP" 2>&1 | sed -n 's/^Identifier=//p')
if [ "$SIGNED_ID" != "$BUNDLE_ID" ]; then
    echo "✕ İmza kimliği Info.plist ile uyuşmuyor: '$SIGNED_ID' ≠ '$BUNDLE_ID'" >&2
    exit 1
fi
echo "✓ Bitti. İzni bir kez daha vermeniz gerekecek; sonraki güncellemelerde gerekmeyecek."
