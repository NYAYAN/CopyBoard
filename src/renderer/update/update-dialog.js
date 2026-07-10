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

// Format release notes (a small markdown subset) to safe HTML.
// SECURITY: releaseNotes comes from the GitHub release feed over the network and is
// UNTRUSTED. We HTML-escape EVERYTHING first, then build tags only from our own markdown
// markers on the already-escaped text — so attacker-supplied HTML (e.g. <img onerror>,
// <svg onload>) is neutralised to inert text before it can reach innerHTML.
// Supported: "#" headers, "-"/"*" bullets, **bold**, `code`, "---" rules, | pipe | tables.
function formatReleaseNotes(notes) {
    if (!notes) return 'Yeni özellikler ve iyileştirmeler.';

    const esc = String(notes)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    // Inline markers, applied to an already-escaped text span.
    const inline = (s) => s
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') // **bold**
        .replace(/`([^`]+?)`/g, '<code>$1</code>');       // `code`

    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const isSep = (l) => /-{2,}/.test(l) && /^\s*\|?[\s:|-]+\|?\s*$/.test(l);

    const lines = esc.split(/\r?\n/);
    const out = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Horizontal rule
        if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

        // Table: header row + "|---|" separator + body rows
        if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
            const head = cells(line).map(c => `<th>${inline(c)}</th>`).join('');
            i += 2;
            let body = '';
            while (i < lines.length && isRow(lines[i]) && !isSep(lines[i])) {
                body += '<tr>' + cells(lines[i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
                i++;
            }
            out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
            continue;
        }

        // Header -> bold block (keeps the existing visual style)
        let m = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
        if (m) { out.push(`<strong>${inline(m[1])}</strong>`); i++; continue; }

        // Bullet
        m = line.match(/^\s*[-*]\s+(.+?)\s*$/);
        if (m) { out.push(`• ${inline(m[1])}<br>`); i++; continue; }

        // Blank line -> spacing
        if (/^\s*$/.test(line)) { out.push('<br>'); i++; continue; }

        // Plain paragraph line
        out.push(`${inline(line)}<br>`); i++;
    }

    return `<div class="release-html-content">${out.join('')}</div>`;
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
