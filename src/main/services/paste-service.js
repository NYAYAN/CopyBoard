const { spawn } = require('child_process');

// Cross-application paste helper (Windows only).
//
// We keep ONE hidden PowerShell process alive and, on first use, define a
// keybd_event-based Ctrl+V via Add-Type. Each paste then only writes "Send-Paste"
// to its stdin, so:
//   - it's fast (the ~one-time Add-Type compile is paid up front, not per paste), and
//   - unlike WScript.Shell.SendKeys it does NOT toggle NumLock, so there's no stray
//     "Num Lock On" OSD / wrong keystroke side effect.
//
// Only fixed commands are ever written to stdin — the user's clipboard text is never
// passed to PowerShell — so there is no shell-injection surface here.

let ps = null;

const INIT =
    "$sig = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, System.UIntPtr e);'; " +
    "$N = Add-Type -MemberDefinition $sig -Name Native -Namespace Paste -PassThru; " +
    "function Send-Paste { " +
    "$N::keybd_event(0x11,0,0,[System.UIntPtr]::Zero); " +   // Ctrl down
    "$N::keybd_event(0x56,0,0,[System.UIntPtr]::Zero); " +   // V down
    "$N::keybd_event(0x56,0,2,[System.UIntPtr]::Zero); " +   // V up   (KEYEVENTF_KEYUP)
    "$N::keybd_event(0x11,0,2,[System.UIntPtr]::Zero) }";    // Ctrl up

function isAlive(p) {
    return p && p.exitCode === null && !p.killed && p.stdin && p.stdin.writable;
}

function spawnHelper() {
    const p = spawn('powershell.exe', ['-NoProfile', '-NoLogo'], {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore']
    });
    p.on('error', () => { if (ps === p) ps = null; });
    p.on('exit', () => { if (ps === p) ps = null; });
    try { p.stdin.write(INIT + '\r\n'); } catch (e) { /* consumers handle a dead pipe */ }
    return p;
}

// Spawn + run the (slow, one-time) Add-Type compile ahead of the actual paste, so
// the paste itself is instant. Safe to call repeatedly; a no-op once warm. Called
// when the picker opens, hiding the compile latency behind the user's read/click.
function warmPasteHelper() {
    if (process.platform !== 'win32') return;
    if (isAlive(ps)) return;
    try { ps = spawnHelper(); } catch (e) { console.error('warmPasteHelper failed:', e); ps = null; }
}

function sendPasteKeystroke() {
    if (process.platform !== 'win32') return;
    try {
        if (!isAlive(ps)) ps = spawnHelper();
        if (isAlive(ps)) ps.stdin.write('Send-Paste\r\n');
    } catch (e) {
        console.error('sendPasteKeystroke failed:', e);
        ps = null;
    }
}

function disposePasteHelper() {
    if (ps) {
        try { ps.stdin.write('exit\r\n'); ps.stdin.end(); } catch (e) {}
        try { ps.kill(); } catch (e) {}
        ps = null;
    }
}

module.exports = { sendPasteKeystroke, warmPasteHelper, disposePasteHelper };
