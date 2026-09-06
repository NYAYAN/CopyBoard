//! Kalıcı ayar deposu — `electron-store`'un yerine geçer.
//!
//! Dosya biçimi Electron sürümüyle BİREBİR aynı (`config.json`, düz JSON nesnesi), çünkü
//! göç (bkz. [`crate::migrate`]) dosyayı olduğu gibi kopyalıyor ve v2'ye geri dönüş
//! mümkün kalmalı.
//!
//! Electron-store'dan taşınması ŞART olan iki davranış:
//!
//! 1. **Eksik anahtar = varsayılan.** Gerçek bir kullanıcı dosyasında `globalShortcutColor`,
//!    `autoStart` ve `quickPasteCount` hiç yoktu; `shortcutsEnabled` içinde `scroll` yoktu.
//!    Katı bir struct'a deserialize etmek bunları hata yapardı.
//!
//! 2. **Tanınmayan anahtarlar korunur.** İçeride `serde_json::Map` tutuluyor, struct değil.
//!    Struct'a okuyup geri yazmak, bu sürümün bilmediği her anahtarı sessizce silerdi —
//!    v2 ile v3 arasında gidip gelen bir kullanıcının verisini yok ederdi.
//!
//! Yazma stratejisi de Electron sürümündeki gibi: pano izleyicisi saniyede bir tetikleyebildiği
//! için yazmalar 500 ms geciktirilip birleştiriliyor, çıkışta/uykuda `flush()` ile boşaltılıyor.
//! Fark: yazma AYRI BİR THREAD'de ve atomik (geçici dosya + rename), yani 1 MB'lık dosya
//! ana thread'i bloklamıyor ve yarıda kesilen bir yazma dosyayı bozmuyor.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};

const DEBOUNCE: Duration = Duration::from_millis(500);

pub struct Store {
    path: PathBuf,
    data: Mutex<Map<String, Value>>,
    /// Diskteki hâl bellekten farklı mı? `flush()` gereksiz yazmayı bununla atlıyor.
    dirty: AtomicBool,
    ping: Mutex<Option<Sender<()>>>,
    /// Disk yazmalarını SERİLEŞTİRİR.
    ///
    /// Bu olmadan iki thread — arka plan yazıcısı ve `flush()` çağıran thread —
    /// `write_now()`a aynı anda girebiliyor. İkisi de aynı geçici dosyayı
    /// `File::create` (O_TRUNC) ile açtığı için AYNI inode üzerinde çalışıyor; biri
    /// `rename` ettikten sonra diğerinin hâlâ açık fd'si artık doğrudan `config.json`ı
    /// gösteriyor ve kalan baytları canlı dosyanın üzerine yazıyor. Sonuç: geçersiz
    /// JSON → açılışta `.corrupt`a alınıp BOŞ depo ile başlanması, yani tüm geçmiş,
    /// favoriler, galeri indeksi ve ayarların kaybı.
    ///
    /// Electron'da bu yapısal olarak imkânsızdı: `electron-store`un tüm yazmaları tek
    /// JS thread'inde senkrondu.
    write_lock: Mutex<()>,
}

impl Store {
    /// Dosyayı okur. Dosya yoksa, okunamıyorsa ya da bozuksa BOŞ bir depo döner —
    /// bozuk bir `config.json` yüzünden uygulama açılmamazlık etmemeli.
    pub fn load(path: PathBuf) -> Arc<Self> {
        let data = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(Value::Object(map)) => map,
                Ok(_) => {
                    log::warn!("config.json bir JSON nesnesi değil — boş depo ile başlanıyor");
                    Map::new()
                }
                Err(e) => {
                    // Bozuk dosyayı ÜZERİNE YAZMADAN önce kenara al: kullanıcının
                    // geçmişi kurtarılabilir olabilir.
                    let backup = path.with_extension("json.corrupt");
                    let _ = std::fs::rename(&path, &backup);
                    log::error!("config.json okunamadı ({e}) — {} olarak yedeklendi", backup.display());
                    Map::new()
                }
            },
            Err(_) => Map::new(), // ilk çalıştırma
        };

        let store = Arc::new(Store {
            path,
            data: Mutex::new(data),
            dirty: AtomicBool::new(false),
            ping: Mutex::new(None),
            write_lock: Mutex::new(()),
        });
        store.clone().spawn_writer();
        store
    }

    /// Testler için: arka plan yazıcı thread'i OLMADAN bir depo.
    ///
    /// Üretimde tek bir depo var ve yazıcısı süreç boyunca yaşıyor. Testte ise her
    /// depo bir thread daha sızdırıyordu, ve daha kötüsü: geciktirilmiş yazma testin
    /// geçici dosyasını SİLİNDİKTEN SONRA geri yaratıyordu (yazıcı `dirty`ye bakmadan
    /// `write_now()` çağırıyor). `$TMPDIR`'de koşu başına altı dosya kalıyor, süreç
    /// kimliği her koşuda değiştiği için birikiyorlardı — bu makinede 181 dosya, 75 MB.
    ///
    /// Yazıcı yokken geciktirilen anahtarlar diske hiç inmiyor; testler depoyu bellek
    /// içi bir sözlük gibi kullanıyor ve gerekirse `flush()` çağırabiliyor.
    #[cfg(test)]
    pub fn load_without_writer(path: PathBuf) -> Arc<Self> {
        Arc::new(Store {
            path,
            data: Mutex::new(Map::new()),
            dirty: AtomicBool::new(false),
            ping: Mutex::new(None),
            write_lock: Mutex::new(()),
        })
    }

    /// Geciktirilmiş yazmaları birleştiren arka plan thread'i.
    fn spawn_writer(self: Arc<Self>) {
        let (tx, rx) = mpsc::channel::<()>();
        *self.ping.lock().unwrap() = Some(tx);

        std::thread::Builder::new()
            .name("copyboard-store".into())
            .spawn(move || {
                while rx.recv().is_ok() {
                    // İlk ping geldi; DEBOUNCE boyunca gelen diğerlerini yut.
                    let deadline = Instant::now() + DEBOUNCE;
                    loop {
                        let left = deadline.saturating_duration_since(Instant::now());
                        if left.is_zero() || rx.recv_timeout(left).is_err() {
                            break;
                        }
                    }
                    self.write_now();
                }
            })
            .expect("store yazıcı thread'i başlatılamadı");
    }

    /// Anahtar yoksa ya da tipi tutmuyorsa `default` döner — `electron-store`'un
    /// `store.get(key, default)` davranışı.
    pub fn get<T: DeserializeOwned>(&self, key: &str, default: T) -> T {
        let data = self.data.lock().unwrap();
        match data.get(key) {
            Some(v) => serde_json::from_value(v.clone()).unwrap_or_else(|e| {
                log::warn!("config.json: '{key}' beklenen tipte değil ({e}) — varsayılan kullanılıyor");
                default
            }),
            None => default,
        }
    }

    pub fn get_value(&self, key: &str) -> Option<Value> {
        self.data.lock().unwrap().get(key).cloned()
    }

    pub fn has(&self, key: &str) -> bool {
        self.data.lock().unwrap().contains_key(key)
    }

    /// Yalnız bu anahtarların yazması geciktirilir.
    ///
    /// Electron yalnız pano izleyicisinin EKLEMESİNİ geciktiriyordu (`history-manager.js`
    /// `saveHistorySoon`, saniyede bir tetiklenebildiği için); geçmişteki silme,
    /// temizleme, not ve sıralama dahil diğer HER yazma anındaydı. Ayarları, favorileri
    /// ve galeri indeksini geciktirmek, kullanıcı bir ayarı değiştirip 500 ms içinde
    /// uygulamayı zorla kapatırsa o ayarın kaybolması demek — ve `panic = "abort"`
    /// ile çıkış flush'ı hiç koşmayabiliyor. Bu yüzden `history` anahtarında da yalnız
    /// ekleme geciktiriliyor; kullanıcı eylemleri [`Store::set_now`] / [`Store::update_now`]
    /// ile anında iniyor.
    const DEBOUNCED_KEYS: [&'static str; 1] = ["history"];

    /// Değeri belleğe yazar. `history` için geciktirilmiş, diğerleri için ANINDA yazar.
    pub fn set<T: Serialize>(&self, key: &str, value: T) {
        self.set_impl(key, value, None);
    }

    /// [`Store::set`] gibi, ama anahtar ne olursa olsun ANINDA diske yazar. Kullanıcının
    /// tıklayıp yaptığı işler için (silme, temizleme, sıralama).
    pub fn set_now<T: Serialize>(&self, key: &str, value: T) {
        self.set_impl(key, value, Some(false));
    }

    fn set_impl<T: Serialize>(&self, key: &str, value: T, debounce_override: Option<bool>) {
        let v = match serde_json::to_value(value) {
            Ok(v) => v,
            Err(e) => {
                log::error!("config.json: '{key}' serialize edilemedi: {e}");
                return;
            }
        };
        {
            let mut data = self.data.lock().unwrap();
            if data.get(key) == Some(&v) {
                return; // değişmedi — disk yazması planlama
            }
            data.insert(key.to_string(), v);
        }
        self.dirty.store(true, Ordering::Release);

        let debounced = debounce_override.unwrap_or_else(|| Self::DEBOUNCED_KEYS.contains(&key));
        if debounced {
            if let Some(tx) = self.ping.lock().unwrap().as_ref() {
                let _ = tx.send(());
            }
        } else {
            self.write_now();
        }
    }

    /// [`Store::update`] gibi, ama anahtar ne olursa olsun ANINDA diske yazar.
    pub fn update_now<T, F>(&self, key: &str, default: T, mutate: F)
    where
        T: DeserializeOwned + Serialize,
        F: FnOnce(&mut T) -> bool,
    {
        self.update_impl(key, default, mutate, Some(false));
    }

    /// Bir anahtarı ATOMİK olarak oku-değiştir-yaz.
    ///
    /// ## Neden gerekli
    ///
    /// `get()` ve `set()` kilidi AYRI AYRI alıyor. `let mut v = get(); v.push(x); set(v)`
    /// kalıbında iki thread araya girebiliyor ve sonuncusu diğerinin eklemesini
    /// düşürüyor. Somut senaryo: pano izleyici yeni bir kayıt eklerken kullanıcı aynı
    /// anda arayüzden bir kaydı siliyor — silme kayboluyor ya da yeni kayıt kayboluyor.
    ///
    /// Kapanış `false` döndürürse hiçbir şey yazılmaz (değişiklik yok).
    pub fn update<T, F>(&self, key: &str, default: T, mutate: F)
    where
        T: DeserializeOwned + Serialize,
        F: FnOnce(&mut T) -> bool,
    {
        self.update_impl(key, default, mutate, None);
    }

    fn update_impl<T, F>(&self, key: &str, default: T, mutate: F, debounce_override: Option<bool>)
    where
        T: DeserializeOwned + Serialize,
        F: FnOnce(&mut T) -> bool,
    {
        let debounced = debounce_override.unwrap_or_else(|| Self::DEBOUNCED_KEYS.contains(&key));
        {
            let mut data = self.data.lock().unwrap();
            let mut current: T = match data.get(key) {
                Some(v) => serde_json::from_value(v.clone()).unwrap_or_else(|e| {
                    log::warn!("config.json: '{key}' beklenen tipte değil ({e}) — varsayılan kullanılıyor");
                    default
                }),
                None => default,
            };
            if !mutate(&mut current) {
                return;
            }
            let v = match serde_json::to_value(&current) {
                Ok(v) => v,
                Err(e) => {
                    log::error!("config.json: '{key}' serialize edilemedi: {e}");
                    return;
                }
            };
            if data.get(key) == Some(&v) {
                return;
            }
            data.insert(key.to_string(), v);
        }
        self.dirty.store(true, Ordering::Release);

        if debounced {
            if let Some(tx) = self.ping.lock().unwrap().as_ref() {
                let _ = tx.send(());
            }
        } else {
            self.write_now();
        }
    }

    /// Bekleyen yazmayı ŞİMDİ diske indir. Çıkışta, uykuda ve ekran kilitlenmesinde
    /// çağrılır — Electron sürümündeki `flushHistorySave()`'in karşılığı.
    pub fn flush(&self) {
        if self.dirty.load(Ordering::Acquire) {
            self.write_now();
        }
    }

    fn write_now(&self) {
        // Yazmanın TAMAMI tek bir thread'e ait: anlık görüntü alma da, disk I/O da.
        // Kilit yalnız serialize sırasında tutulsaydı iki yazma iç içe geçebilirdi.
        let _writing = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());

        let snapshot = {
            let data = self.data.lock().unwrap();
            // Kilit yalnız serialize süresince tutulur; disk I/O kilit DIŞINDA yapılır.
            match serde_json::to_vec_pretty(&Value::Object(data.clone())) {
                Ok(bytes) => bytes,
                Err(e) => {
                    log::error!("config.json serialize edilemedi: {e}");
                    return;
                }
            }
        };

        if let Err(e) = atomic_write(&self.path, &snapshot) {
            // Yazma başarısız: dirty bayrağını BIRAKMA, bir sonraki flush yeniden dener.
            log::error!("config.json yazılamadı ({}): {e}", self.path.display());
            return;
        }
        self.dirty.store(false, Ordering::Release);
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Geçici dosyaya yaz, fsync'le, sonra yerine taşı. Yarıda kesilen bir yazma
/// (çökme, elektrik kesintisi) kullanıcının 1 MB'lık geçmişini yarım bırakmasın.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Geçici ad SÜREÇ + THREAD'e özgü. `write_lock` aynı süreçte çakışmayı zaten
    // engelliyor; bu, iki CopyBoard örneğinin (tek örnek kilidi bir sebeple düşerse)
    // ya da eski bir sürümün aynı geçici adı kullanmasına karşı ikinci hat.
    let tmp = path.with_extension(format!(
        "json.tmp.{}.{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Kapsamdan çıkınca dosyayı SİLEN geçici yol. Eskiden yalnız açılışta eskisini
    /// siliyordu ve süreç kimliği her koşuda değiştiği için dosyalar birikiyordu.
    fn temp_path(name: &str) -> crate::testutil::TempPath {
        crate::testutil::TempPath::json(&format!("store-test-{name}"))
    }

    /// `get` + `set` ayrı kilit aldığı için araya giren yazma KAYBOLUYORDU.
    /// Aynı senaryo `update` ile hiçbir ekleme düşürmemeli.
    #[test]
    fn update_es_zamanli_eklemelerin_hicbirini_dusurmuyor() {
        const THREADS: usize = 8;
        const PER_THREAD: usize = 50;

        // Önce hatayı GÖSTER: get+set kalıbı gerçekten kayıp veriyor mu?
        let _t = temp_path("yaris-naive");
        let naive = Store::load(_t.to_path_buf());
        std::thread::scope(|scope| {
            for t in 0..THREADS {
                let store = naive.clone();
                scope.spawn(move || {
                    for i in 0..PER_THREAD {
                        let mut v: Vec<u64> = store.get("liste", Vec::new());
                        v.push((t * PER_THREAD + i) as u64);
                        store.set("liste", &v);
                    }
                });
            }
        });
        let naive_len = naive.get::<Vec<u64>>("liste", Vec::new()).len();
        eprintln!("naive get+set: {naive_len}/{} kayıt hayatta kaldı", THREADS * PER_THREAD);

        // Şimdi düzeltmeyi doğrula: atomik oku-değiştir-yaz hiçbir şey düşürmemeli.
        let _t = temp_path("yaris-atomic");
        let atomic = Store::load(_t.to_path_buf());
        std::thread::scope(|scope| {
            for t in 0..THREADS {
                let store = atomic.clone();
                scope.spawn(move || {
                    for i in 0..PER_THREAD {
                        store.update("liste", Vec::<u64>::new(), |v: &mut Vec<u64>| {
                            v.push((t * PER_THREAD + i) as u64);
                            true
                        });
                    }
                });
            }
        });
        let mut got: Vec<u64> = atomic.get("liste", Vec::new());
        got.sort_unstable();

        assert_eq!(
            got.len(),
            THREADS * PER_THREAD,
            "atomik güncellemede kayıp var (naive kalıp {naive_len} kayıt bırakmıştı)"
        );
        assert_eq!(got, (0..(THREADS * PER_THREAD) as u64).collect::<Vec<_>>());
    }

    #[test]
    fn update_false_donerse_hicbir_sey_yazmiyor() {
        let _t = temp_path("update-noop");
        let s = Store::load(_t.to_path_buf());
        s.set("liste", vec![1u64, 2, 3]);
        s.update("liste", Vec::<u64>::new(), |v: &mut Vec<u64>| {
            v.push(4); // değiştirdik AMA kaydetme dedik
            false
        });
        assert_eq!(s.get::<Vec<u64>>("liste", Vec::new()), vec![1, 2, 3]);
    }

    #[test]
    fn eksik_anahtar_varsayilana_duser() {
        let _t = temp_path("missing");
        let s = Store::load(_t.to_path_buf());
        assert_eq!(s.get::<i64>("maxItems", 50), 50);
        assert_eq!(s.get::<String>("theme", "dark".into()), "dark");
        assert!(!s.has("globalShortcutColor"));
    }

    #[test]
    fn yanlis_tip_varsayilana_duser_ve_uygulamayi_dusurmez() {
        let p = temp_path("badtype");
        std::fs::write(&p, r#"{"maxItems":"elli"}"#).unwrap();
        let s = Store::load(p.to_path_buf());
        assert_eq!(s.get::<i64>("maxItems", 50), 50);
    }

    #[test]
    fn bozuk_json_yedeklenir_ve_bos_depo_ile_acilir() {
        let p = temp_path("corrupt");
        std::fs::write(&p, "{ bu json değil ").unwrap();
        let s = Store::load(p.to_path_buf());
        assert_eq!(s.get::<i64>("maxItems", 50), 50);
        assert!(p.with_extension("json.corrupt").exists());
        let _ = std::fs::remove_file(p.with_extension("json.corrupt"));
    }

    #[test]
    fn taninmayan_anahtarlar_yazmadan_sonra_korunur() {
        let p = temp_path("unknown");
        std::fs::write(&p, r#"{"maxItems":50,"gelecekteBirAyar":{"a":1},"history":[]}"#).unwrap();
        let s = Store::load(p.to_path_buf());
        s.set("maxItems", 100);
        s.flush();

        let back: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(back["maxItems"], json!(100));
        // Bu sürümün hiç bilmediği anahtar hâlâ orada:
        assert_eq!(back["gelecekteBirAyar"]["a"], json!(1));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn ayni_degeri_yazmak_disk_yazmasi_planlamaz() {
        let p = temp_path("noop");
        let s = Store::load(p.to_path_buf());
        s.set("maxItems", 50);
        s.flush();
        s.set("maxItems", 50);
        assert!(!s.dirty.load(Ordering::Acquire));
        let _ = std::fs::remove_file(p);
    }
}
