//! Testlerin geçici dosyaları — KENDİLERİNİ SİLEN.
//!
//! Test yardımcıları `$TMPDIR/copyboard-<ad>-<pid>.json` gibi yollar üretiyor,
//! açılışta eskisini siliyor ama sonunda hiçbir şey silmiyordu. Süreç kimliği her
//! `cargo test` koşusunda değiştiği için dosyalar BİRİKİYORDU: bu makinede 633 MB
//! (çoğu OCR testinin her koşuda yeniden serdiği dil verisi).
//!
//! `TempPath` kapsamdan çıkınca yolu siliyor.

#![cfg(test)]

use std::path::{Path, PathBuf};

pub struct TempPath(PathBuf);

impl TempPath {
    /// `$TMPDIR/copyboard-<ad>-<pid>.json` — varsa önceki koşudan kalanı siler.
    pub fn json(name: &str) -> Self {
        let mut p = std::env::temp_dir();
        p.push(format!("copyboard-{name}-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&p);
        Self(p)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn to_path_buf(&self) -> PathBuf {
        self.0.clone()
    }
}

impl AsRef<Path> for TempPath {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl std::ops::Deref for TempPath {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempPath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
