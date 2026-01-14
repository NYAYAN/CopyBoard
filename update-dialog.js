// Update dialog renderer process
const { ipcRenderer } = require('electron');

let updateInfo = null;

// Initialize dialog with update info
ipcRenderer.on('update-info', (event, info) => {
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
});

// Format release notes from markdown to HTML
function formatReleaseNotes(notes) {
    if (!notes) return 'Yeni özellikler ve iyileştirmeler.';

    // Convert markdown-style formatting to HTML
    let formatted = notes
        .replace(/^### (.+)$/gm, '<strong>$1</strong>') // Headers
        .replace(/^- (.+)$/gm, '• $1') // Bullet points
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') // Bold
        .replace(/\n/g, '<br>'); // Line breaks

    return formatted;
}

// Update download progress
ipcRenderer.on('download-progress', (event, progressObj) => {
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
ipcRenderer.on('update-downloaded', () => {
    const updateBtn = document.getElementById('updateBtn');
    const progressLabel = document.querySelector('.progress-label');

    // Update UI
    progressLabel.textContent = 'İndirme Tamamlandı!';
    document.getElementById('progressFill').style.width = '100%';
    document.getElementById('progressPercent').textContent = '100%';

    // Change button text
    updateBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
    Yeniden Başlat ve Güncelle
  `;
    updateBtn.disabled = false;

    // Auto-install after 3 seconds
    let countdown = 3;
    const countdownInterval = setInterval(() => {
        updateBtn.textContent = `Yeniden Başlatılıyor... (${countdown})`;
        countdown--;

        if (countdown < 0) {
            clearInterval(countdownInterval);
            ipcRenderer.send('install-update');
        }
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
    // Start download
    ipcRenderer.send('download-update');

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
