const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);
const Notes = window.CopyBoardNotes;

// States (body[data-state]): available → downloading → ready, or error. The stylesheet
// shows the sections of the current state; this file only switches it and fills text.
let updateInfo = null;
let countdownTimer = null;

const $ = (id) => document.getElementById(id);
const setState = (s) => { document.body.dataset.state = s; };

const lang = (window.api && window.api.i18n && window.api.i18n.lang) || 'tr';
const locale = lang === 'en' ? 'en-US' : 'tr-TR';
const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

function formatMB(bytes) {
    return num.format(bytes / 1048576);
}

// Turkish writes the percent sign first ("%48").
function formatPercent(p) {
    const n = Math.max(0, Math.min(100, Math.round(p)));
    return lang === 'en' ? `${n}%` : `%${n}`;
}

function setHeader(title, subtitle) {
    $('title').textContent = title;
    $('subtitle').textContent = subtitle;
}

Notes.interceptLinks($('notesContent'), (href) => window.api.openExternal(href));

window.api.onUpdateInfo((info) => {
    updateInfo = info;
    $('currentVersion').textContent = info.currentVersion;
    $('newVersion').textContent = info.version;

    // The notes shown here are the TARGET version's. When several versions are being
    // skipped, say so; the full list is one click away in the large window.
    const newer = Notes.newerThan(info.changelog, info.currentVersion);
    if (newer.length > 1) {
        $('coverage').textContent = t('Bu güncelleme {n} sürümü kapsıyor', { n: newer.length });
        $('coverage').classList.remove('hidden');
    }
    const target = newer.find((e) => Notes.compareVersions(e.version, info.version) === 0);
    const notes = info.releaseNotes || (target && target.notes) || '';
    Notes.renderInto($('notesContent'), notes, t('Yeni özellikler ve iyileştirmeler.'));

    // The bridge has no window for it under Electron (this renderer is shared).
    if (typeof window.api.openReleaseNotes === 'function') {
        $('allNotesBtn').classList.remove('hidden');
    }

    // Electron only: Squirrel.Mac can't apply an unsigned update, so the Electron main
    // process sends `isMac` and the button points to GitHub instead. The Tauri backend
    // never sends it — its updater checks the minisign signature and swaps the .app in
    // place on macOS too (src-tauri/src/updater.rs).
    if (info.isMac) {
        $('updateBtnText').textContent = t('İndir (GitHub)');
    }
    setState('available');
});

$('allNotesBtn').addEventListener('click', () => window.api.openReleaseNotes());

function startDownload() {
    if (updateInfo && updateInfo.isMac) {
        // Electron only (see onUpdateInfo): its macOS build can't self-update, and its
        // releases are tagged `v<version>`.
        window.api.openExternal(`https://github.com/NYAYAN/CopyBoard/releases/tag/v${updateInfo.version}`);
        window.close();
        return;
    }
    setHeader(
        t('{version} indiriliyor', { version: (updateInfo && updateInfo.version) || '' }),
        t('İndirme bitince imzası doğrulanacak')
    );
    $('progressFill').style.width = '0%';
    $('progressPercent').textContent = formatPercent(0);
    $('downloadSize').textContent = '';
    $('downloadSpeed').textContent = '';
    setState('downloading');
    window.api.downloadUpdate();
}

$('updateBtn').addEventListener('click', startDownload);
$('laterBtn').addEventListener('click', () => window.close());

window.api.onDownloadProgress((p) => {
    if (document.body.dataset.state !== 'downloading') setState('downloading');
    $('progressFill').style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
    $('progressPercent').textContent = formatPercent(p.percent || 0);
    if (p.total) {
        $('downloadSize').textContent = `${formatMB(p.transferred || 0)} / ${formatMB(p.total)} MB`;
    }
    if (p.bytesPerSecond) {
        $('downloadSpeed').textContent = lang === 'en'
            ? `${formatMB(p.bytesPerSecond)} MB/s`
            : `${formatMB(p.bytesPerSecond)} MB/sn`;
    }
});

function install() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    $('restartBtn').disabled = true;
    $('cancelBtn').disabled = true;
    window.api.installUpdate();
}

// Downloaded and verified: count 3, 2, 1, then install (no "0" frame). "Restart" installs
// at once; "Cancel" stops the countdown and closes the dialog.
window.api.onUpdateDownloaded(() => {
    setHeader(t('Güncelleme indirildi'), t('İmzası doğrulandı'));
    setState('ready');
    let left = 3;
    $('countdown').textContent = String(left);
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
            install();
            return;
        }
        $('countdown').textContent = String(left);
    }, 1000);
});

$('restartBtn').addEventListener('click', install);
$('cancelBtn').addEventListener('click', () => {
    clearInterval(countdownTimer);
    countdownTimer = null;
    window.close();
});

// A raw transport/OS error ("error sending request for url (…): operation timed out")
// becomes a sentence the user can act on; the raw text stays underneath, small, for a
// bug report. Messages the backend already wrote for people ("Güncelleme bulunamadı.")
// are shown as they are.
function describeError(raw) {
    const text = String(raw || '').trim();
    if (!/https?:\/\/|error|failed|os error|\(/i.test(text)) return { main: text || t('Beklenmeyen bir hata oluştu.'), detail: '' };
    const s = text.toLowerCase();
    let main = t('Beklenmeyen bir hata oluştu.');
    if (/signature|minisign|verif/.test(s)) main = t('Paketin imzası doğrulanamadı; güvenliğiniz için kurulmadı.');
    else if (/timed out|timeout/.test(s)) main = t('Bağlantı zaman aşımına uğradı.');
    else if (/dns|resolve|connect|network|offline|unreachable/.test(s)) main = t('Sunucuya bağlanılamadı. İnternet bağlantınızı denetleyin.');
    else if (/not found|404/.test(s)) main = t('Güncelleme dosyası bulunamadı.');
    return { main, detail: text };
}

window.api.onUpdateError((message) => {
    clearInterval(countdownTimer);
    countdownTimer = null;
    setHeader(t('Güncelleme indirilemedi'), t('Yeniden deneyebilirsiniz'));
    const { main, detail } = describeError(message);
    $('errorText').textContent = main;
    $('errorDetail').textContent = detail;
    $('updateBtnText').textContent = t('Tekrar dene');
    $('restartBtn').disabled = false;
    $('cancelBtn').disabled = false;
    setState('error');
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const s = document.body.dataset.state;
    if (s === 'available' || s === 'error') window.close();
});
