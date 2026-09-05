#!/usr/bin/env bash
# Paketleme başlamadan önce macOS kod imzalama kimliğini doğrular.
#
# ## Neden var
#
# `APPLE_SIGNING_IDENTITY` tanımlı değilse Tauri paketi SESSİZCE ad-hoc imzalar:
# hata yok, uyarı yok, sadece çıktıdan "Signing with identity" satırları eksilir.
# Ad-hoc imzanın belirlenmiş gereksinimi binary'nin cdhash'i olduğu için macOS o
# paketi YENİ BİR UYGULAMA sayar ve Ekran Kaydı izni sıfırlanır — kullanıcı bunu
# ancak uygulamayı çalıştırıp izin ekranıyla karşılaşınca fark eder.
#
# Bu tam olarak başımıza geldi: profile eklenen değişkeni, o düzenlemeden ÖNCE
# açılmış bir terminal görmüyordu ve derleme imzasız çıktı.
#
# Bilerek imzasız derlemek için: COPYBOARD_ALLOW_UNSIGNED=1

set -euo pipefail

[ "$(uname -s)" = "Darwin" ] || exit 0

if [ "${COPYBOARD_ALLOW_UNSIGNED:-0}" = "1" ]; then
    echo "  İmza kontrolü atlandı (COPYBOARD_ALLOW_UNSIGNED=1) — paket ad-hoc imzalanacak."
    exit 0
fi

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
    cat >&2 <<'MSG'

  ✗ APPLE_SIGNING_IDENTITY tanımlı değil — paket ad-hoc imzalanırdı.

    Sonucu: macOS bu paketi yeni bir uygulama sayar ve Ekran Kaydı / Erişilebilirlik
    izinlerini yeniden ister. Her derlemede yeniden.

    Bu kabuk değişkeni görmüyorsa, büyük ihtimalle ~/.zshrc düzenlenmeden önce
    açılmıştır. Yeni bir terminal açın ya da:

        source ~/.zshrc

    Kurulum yapılmadıysa: SIGNING.md → "Geliştirme sırasında: izinler neden her
    derlemede sıfırlanıyor"

    Bilerek imzasız derlemek için: COPYBOARD_ALLOW_UNSIGNED=1 npm run build

MSG
    exit 1
fi

if ! security find-identity -v -p codesigning 2>/dev/null | grep -qF "\"${APPLE_SIGNING_IDENTITY}\""; then
    cat >&2 <<MSG

  ✗ "${APPLE_SIGNING_IDENTITY}" anahtarlıkta geçerli bir kod imzalama kimliği değil.

    Mevcut kimlikler:
$(security find-identity -v -p codesigning 2>&1 | sed 's/^/    /')

    Sertifika var ama listede yoksa "Always Trust" adımı eksik olabilir — SIGNING.md.

MSG
    exit 1
fi

echo "  İmzalama kimliği doğrulandı: ${APPLE_SIGNING_IDENTITY}"
