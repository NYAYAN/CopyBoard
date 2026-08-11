const { spawn, execFile } = require('child_process');
const { systemPreferences } = require('electron');

// Cross-application paste helper.
//
// Two completely different mechanisms, because the platforms are:
//   - Windows: a warm PowerShell process firing keybd_event Ctrl+V (below).
//   - macOS:   osascript → System Events keystroke "v" using command down (further down).
//              This needs Accessibility permission; there is no permission-free
//              equivalent of SendInput on macOS.
//
// ── Windows ─────────────────────────────────────────────────────────────────
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
function warmWindows() {
    if (isAlive(ps)) return;
    try { ps = spawnHelper(); } catch (e) { console.error('warmPasteHelper failed:', e); ps = null; }
}

function sendPasteWindows() {
    try {
        if (!isAlive(ps)) ps = spawnHelper();
        if (isAlive(ps)) ps.stdin.write('Send-Paste\r\n');
    } catch (e) {
        console.error('sendPasteKeystroke failed:', e);
        ps = null;
    }
}

// ── macOS ───────────────────────────────────────────────────────────────────
//
// The picker window is focusable:false + showInactive(), so in the normal case the
// user's text field never loses first-responder status and a bare Cmd+V lands in it.
// That is not guaranteed though — a click on the panel can still activate us in some
// window-server states — so we remember which app was frontmost when the picker
// opened and re-activate it right before the keystroke. Activating an app that is
// already frontmost is a no-op, so this costs nothing in the common case.
//
// Both the frontmost-app query and the keystroke go through System Events, which
// requires Accessibility permission. See ensureAccessibility().

let macFrontApp = null;
let macFrontAppAt = 0;

// How long a remembered target stays usable. It only has to survive the picker being
// opened from OUR OWN UI (widget button / tray menu), where the click makes CopyBoard
// frontmost and the real target is the app the user was in a moment earlier: hover →
// click → read the list → pick. Short enough that we never yank a long-forgotten app
// to the front.
const FRONT_APP_TTL_MS = 120000;

// Bundle ids are [A-Za-z0-9.-]; anything else is not one, and we refuse to
// interpolate it into AppleScript source.
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

// Never "restore focus" to ourselves — if CopyBoard was frontmost when the picker
// opened there is no other app to hand the keystroke back to.
function isSelf(id) {
    return /copyboard/i.test(id) || id === 'com.github.Electron';
}

function osa(args, cb) {
    execFile('/usr/bin/osascript', args, { timeout: 5000 }, cb || (() => {}));
}

// Remember the app to paste into. Called when the picker opens, so the answer is
// ready (and the osascript startup cost is paid) before the user clicks — and from
// the widget on hover, which is the last moment we are still NOT the frontmost app.
function captureFrontmostApp() {
    osa(
        ['-e', 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true'],
        (err, stdout) => {
            const id = err ? '' : String(stdout).trim();
            if (BUNDLE_ID.test(id) && !isSelf(id)) {
                macFrontApp = id;
                macFrontAppAt = Date.now();
                return;
            }
            // Frontmost is CopyBoard itself: the picker was opened from the widget or
            // the tray, whose click took focus. KEEP the app the user was actually in —
            // clearing it here would send the Cmd+V to our own window. Only a target
            // that has gone stale is dropped.
            if (Date.now() - macFrontAppAt > FRONT_APP_TTL_MS) macFrontApp = null;
        }
    );
}

// osascript failure codes worth telling the user apart. Note that Accessibility and
// Automation are SEPARATE grants: isTrustedAccessibilityClient() only knows about the
// first, so a -1743 can still come back after that check has passed.
//   -1743  Automation denied  ("not authorized to send Apple events to System Events")
//   -1719 / -25211  Accessibility denied / no accessibility API access
function classifyOsaError(msg) {
    if (/-1743/.test(msg)) return 'automation';
    if (/-1719|-25211/.test(msg)) return 'accessibility';
    return 'unknown';
}

function sendPasteMac(onError) {
    const args = [];
    const target = (macFrontApp && Date.now() - macFrontAppAt <= FRONT_APP_TTL_MS) ? macFrontApp : null;
    if (target) {
        args.push('-e', `tell application id "${target}" to activate`);
        args.push('-e', 'delay 0.06');
    }
    args.push('-e', 'tell application "System Events" to keystroke "v" using command down');
    osa(args, (err) => {
        if (!err) return;
        const msg = String(err.message || '');
        console.error('macOS paste failed:', msg);
        if (onError) onError(classifyOsaError(msg));
    });
}

// True when we're allowed to synthesize the keystroke. When `prompt` is set and we
// are not trusted, macOS shows its own "open System Settings" dialog — this is what
// keeps the user from having to find the Accessibility pane by hand.
function ensureAccessibility(prompt) {
    if (process.platform !== 'darwin') return true;
    try {
        return systemPreferences.isTrustedAccessibilityClient(!!prompt);
    } catch (e) {
        console.error('accessibility check failed:', e);
        return true; // don't block the paste on a failed probe
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

let promptedThisRun = false;

function warmPasteHelper() {
    if (process.platform === 'win32') return warmWindows();
    if (process.platform !== 'darwin') return;

    // Ask for Accessibility when the picker is opened without it, so the permission
    // dialog arrives before the user has picked something and watched nothing happen.
    // Only ONCE per run: the grant does not apply to an already-running process, so
    // re-prompting on every open would just nag someone who has already said yes and
    // is waiting on a restart.
    const trusted = ensureAccessibility(!promptedThisRun);
    promptedThisRun = true;
    if (trusted) captureFrontmostApp();
}

// Refresh the paste target WITHOUT prompting for anything. Called from the widget the
// moment the cursor lands on it — the click that follows makes CopyBoard frontmost, so
// this hover is the last chance to see which app the user is actually typing in.
// Throttled: the cursor crosses the widget often and each call costs an osascript spawn.
const NOTE_THROTTLE_MS = 1500;
let lastNoteAt = 0;

function noteFrontApp() {
    if (process.platform !== 'darwin') return;
    const now = Date.now();
    if (now - lastNoteAt < NOTE_THROTTLE_MS) return;
    lastNoteAt = now;
    // Never prompt here — an Accessibility/Automation dialog popped by a mere hover
    // would be baffling. warmPasteHelper() owns the one prompt per run.
    if (ensureAccessibility(false)) captureFrontmostApp();
}

// onError('automation' | 'accessibility' | 'unknown') — macOS only, fired async when
// the keystroke could not be delivered.
function sendPasteKeystroke(onError) {
    if (process.platform === 'win32') return sendPasteWindows();
    if (process.platform === 'darwin') return sendPasteMac(onError);
}

function disposePasteHelper() {
    if (ps) {
        try { ps.stdin.write('exit\r\n'); ps.stdin.end(); } catch (e) {}
        try { ps.kill(); } catch (e) {}
        ps = null;
    }
}

module.exports = { sendPasteKeystroke, warmPasteHelper, noteFrontApp, disposePasteHelper, ensureAccessibility };
