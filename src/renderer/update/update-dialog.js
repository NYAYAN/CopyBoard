const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);
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
        notesContent.textContent = t('Yeni özellikler ve iyileştirmeler.');
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

// Render GitHub release notes safely.
// electron-updater delivers GitHub release notes as HTML — the <content type="html">
// of the releases Atom feed (see GitHubProvider getNoteValue), NOT markdown. So we
// PARSE that HTML and rebuild it from a strict whitelist: text becomes text nodes,
// only known-safe elements survive, and the ONLY attribute kept is an http(s)/mailto
// href on links. Scripts, event handlers, styles, src, etc. are all dropped.
// releaseNotes is untrusted network input, so nothing from it is ever assigned as
// live HTML — elements are created by name and text via createTextNode.
function formatReleaseNotes(notes) {
    if (!notes) return t('Yeni özellikler ve iyileştirmeler.');

    const ALLOWED = new Set([
        'P', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'CODE', 'PRE',
        'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'BLOCKQUOTE', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN'
    ]);

    const sanitize = (src, dst) => {
        src.childNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                dst.appendChild(document.createTextNode(node.nodeValue));
            } else if (node.nodeType === Node.ELEMENT_NODE && ALLOWED.has(node.tagName)) {
                const el = document.createElement(node.tagName);
                if (node.tagName === 'A') {
                    const href = node.getAttribute('href') || '';
                    if (/^(https?:|mailto:)/i.test(href)) {
                        el.setAttribute('href', href);
                        el.setAttribute('target', '_blank');
                        el.setAttribute('rel', 'noreferrer noopener');
                    }
                }
                sanitize(node, el);
                dst.appendChild(el);
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                // Blocked tag: drop the tag itself but keep its sanitized contents.
                sanitize(node, dst);
            }
        });
    };

    try {
        // Tauri's updater hands over the GitHub release BODY, which is Markdown (tauri-action
        // writes it into latest.json as-is); electron-updater gave HTML. If the text carries
        // no tags at all, render the common Markdown shapes first — the sanitizer below still
        // rebuilds everything from the whitelist, so nothing here is trusted either.
        const looksLikeHtml = /<\s*[a-z][\s\S]*>/i.test(String(notes));
        const html = looksLikeHtml ? String(notes) : markdownToHtml(String(notes));
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const container = document.createElement('div');
        container.className = 'release-html-content';
        sanitize(parsed.body, container);
        return container.outerHTML;
    } catch (e) {
        const div = document.createElement('div');
        div.className = 'release-html-content';
        div.textContent = String(notes); // inert plain-text fallback
        return div.outerHTML;
    }
}

// Minimal Markdown → HTML for release bodies: headings, bullet lists, paragraphs, bold,
// inline code and links. Text is escaped first; the result only ever reaches the DOM
// through the whitelist sanitizer in formatReleaseNotes.
function markdownToHtml(md) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s) => esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

    const out = [];
    let list = null;      // 'ul' | 'ol' while inside a list
    let para = [];
    const flushPara = () => { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };

    for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.trimEnd();
        let m;
        if (!line.trim()) { flushPara(); closeList(); continue; }
        if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
            flushPara(); closeList();
            const lvl = Math.min(m[1].length + 2, 6); // #→h3: the dialog is small
            out.push('<h' + lvl + '>' + inline(m[2]) + '</h' + lvl + '>');
        } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
            flushPara();
            if (list !== 'ul') { closeList(); list = 'ul'; out.push('<ul>'); }
            out.push('<li>' + inline(m[1]) + '</li>');
        } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
            flushPara();
            if (list !== 'ol') { closeList(); list = 'ol'; out.push('<ol>'); }
            out.push('<li>' + inline(m[1]) + '</li>');
        } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
            flushPara(); closeList(); out.push('<hr>');
        } else {
            closeList();
            para.push(inline(line.trim()));
        }
    }
    flushPara(); closeList();
    return out.join('');
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
    progressLabel.textContent = t('İndirme Tamamlandı!');
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
