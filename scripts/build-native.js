'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Builds native/mac-hotkey after `npm install`.
//
// Deliberately best-effort: this addon only adds the ability to bind a handful of
// physical keys Electron can't name (the ISO key below Esc, the JIS keys). Everything
// else in the app works without it, so a machine with no Xcode Command Line Tools
// should still end up with a usable checkout — it just can't bind those keys. Failing
// the install over that would be the worse trade.
//
// Skipped entirely off macOS: the gyp target builds to nothing there anyway.

const ADDON_DIR = path.join(__dirname, '..', 'native', 'mac-hotkey');
const BINARY = path.join(ADDON_DIR, 'build', 'Release', 'mac_hotkey.node');

if (process.platform !== 'darwin') {
    console.log('[native] macOS dışı platform — mac-hotkey atlandı');
    process.exit(0);
}

if (!fs.existsSync(path.join(ADDON_DIR, 'binding.gyp'))) {
    console.log('[native] native/mac-hotkey yok — atlandı');
    process.exit(0);
}

const gyp = path.join(__dirname, '..', 'node_modules', '.bin', 'node-gyp');
if (!fs.existsSync(gyp)) {
    console.warn('[native] node-gyp bulunamadı — mac-hotkey derlenmedi');
    process.exit(0);
}

const result = spawnSync(gyp, ['rebuild'], { cwd: ADDON_DIR, stdio: 'inherit', shell: false });

if (result.status === 0 && fs.existsSync(BINARY)) {
    console.log('[native] mac-hotkey derlendi');
} else {
    console.warn(
        '[native] mac-hotkey derlenemedi — uygulama çalışır, yalnızca Electron\'un\n' +
        '         adlandıramadığı tuşlar (Esc altındaki ISO tuşu) kısayol olarak atanamaz.\n' +
        '         Gerekirse: xcode-select --install'
    );
}
