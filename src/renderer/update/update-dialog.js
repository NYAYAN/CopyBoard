// Update dialog renderer process
let updateInfo = null;

// Initialize dialog with update info
window.api.onUpdateInfo((info) => {
    updateInfo = info;

    // Update version numbers
    document.getElementById('currentVersion').textContent = `v${info.currentVersion}`;
    document.getElementById('newVersion').textContent = `v${info.version}`;

    // Update release notes
    const notesContent = document.getElementById('notesContent');
    if (info.releaseNotes) {
        // Parse markdown-style release notes to HTML
        const formattedNotes = formatReleaseNotes(info.releaseNotes);
        notesContent.innerHTML = formattedNotes;
    } else {
        notesContent.textContent = 'Yeni özellikler ve iyileştirmeler.';
    }

    // If Mac, change update button text
    if (info.isMac) {
        const updateBtn = document.getElementById('updateBtn');
        updateBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
        İndir (GitHub)
        `;
    }
});

// Handle update errors
window.api.onUpdateError((message) => {
    const updateBtn = document.getElementById('updateBtn');
    const laterBtn = document.getElementById('laterBtn');
    const progressLabel = document.querySelector('.progress-label');

    // Reset UI
    updateBtn.disabled = false;
    laterBtn.disabled = false;

    // Show error in button or progress area
    updateBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
    Tekrar Dene
    `;

    if (progressLabel) {
        progressLabel.textContent = `Hata: ${message}`;
        progressLabel.style.color = '#ff5555';
    } else {
        alert('Güncelleme hatası: ' + message);
    }
});

// Format release notes from markdown to safe HTML.
// SECURITY: releaseNotes comes from the GitHub release feed over the network and is
// UNTRUSTED. We HTML-escape the input FIRST, then apply a fixed set of markdown->HTML
// transforms to the already-escaped text. This way only our own markers can ever produce
// tags; any attacker-supplied HTML (e.g. <img onerror>, <svg onload>) is neutralised to
// inert text before it can reach innerHTML. (Replaces the old <script>/<iframe> denylist,
// which was trivially bypassed by other event-handler-bearing tags.)
function formatReleaseNotes(notes) {
    if (!notes) return 'Yeni özellikler ve iyileştirmeler.';

    const escaped = String(notes)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const formatted = escaped
        .replace(/^#+ (.+)$/gm, '<strong>$1</strong>') // Headers (#, ##, ###) -> strong
        .replace(/^- (.+)$/gm, '• $1')                  // Bullet points
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') // Bold
        .replace(/\n/g, '<br>');                        // Line breaks

    // Wrap in a stylized container to match the UI better (smaller fonts for lists etc)
    return `<div class="release-html-content">${formatted}</div>`;
}

// Update download progress
window.api.onDownloadProgress((progressObj) => {
    const progressContainer = document.getElementById('downloadProgress');
    const progressFill = document.getElementById('progressFill');
    const progressPercent = document.getElementById('progressPercent');
    const downloadSpeed = document.getElementById('downloadSpeed');
    const downloadSize = document.getElementById('downloadSize');

    // Show progress container
    progressContainer.classList.remove('hidden');

    // Update progress bar
    const percent = Math.round(progressObj.percent);
    progressFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;

    // Update speed and size
    if (progressObj.bytesPerSecond) {
        downloadSpeed.textContent = formatBytes(progressObj.bytesPerSecond) + '/s';
    }

    if (progressObj.transferred && progressObj.total) {
        downloadSize.textContent = `${formatBytes(progressObj.transferred)} / ${formatBytes(progressObj.total)}`;
    }

    // Disable buttons during download
    document.getElementById('updateBtn').disabled = true;
    document.getElementById('laterBtn').disabled = true;
});

// Update downloaded - ready to install
window.api.onUpdateDownloaded(() => {
    const updateBtn = document.getElementById('updateBtn');
    const progressLabel = document.querySelector('.progress-label');

    // Update UI
    progressLabel.textContent = 'İndirme Tamamlandı!';
    document.getElementById('progressFill').style.width = '100%';
    document.getElementById('progressPercent').textContent = '100%';

    // Change button text — disabled, smaller font
    updateBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
    Yeniden Başlat ve Güncelle
  `;
    updateBtn.disabled = true;
    updateBtn.style.fontSize = '11px';

    // Auto-install after 3 seconds — display (3),(2),(1) then install (no "(0)" frame, no 4th second)
    let countdown = 3;
    updateBtn.textContent = `Yeniden Başlatılıyor... (${countdown})`;
    const countdownInterval = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
            clearInterval(countdownInterval);
            window.api.installUpdate();
            return;
        }
        updateBtn.textContent = `Yeniden Başlatılıyor... (${countdown})`;
    }, 1000);

    // Allow user to cancel auto-install
    document.getElementById('laterBtn').disabled = false;
    document.getElementById('laterBtn').onclick = () => {
        clearInterval(countdownInterval);
        window.close();
    };
});

// Format bytes to human readable
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Button event listeners
document.getElementById('updateBtn').addEventListener('click', () => {
    if (updateInfo && updateInfo.isMac) {
        // For Mac without code signing, redirect to release page
        const releaseUrl = `https://github.com/NYAYAN/CopyBoard/releases/tag/v${updateInfo.version}`;
        window.api.openExternal(releaseUrl);
        window.close();
        return;
    }

    // Start download
    window.api.downloadUpdate();

    // Update button state
    const btn = document.getElementById('updateBtn');
    btn.disabled = true;
    btn.innerHTML = `
    <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 12a9 9 0 11-6.219-8.56"/>
    </svg>
    İndiriliyor...
  `;
});

document.getElementById('laterBtn').addEventListener('click', () => {
    window.close();
});

// Add spinning animation for loading icon
const style = document.createElement('style');
style.textContent = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .spin {
    animation: spin 1s linear infinite;
  }
`;
document.head.appendChild(style);
