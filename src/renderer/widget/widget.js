const mainBtn = document.getElementById('widget-main');
const menu = document.getElementById('widget-menu');
const btnSnippet = document.getElementById('btn-snippet');
const btnScreenshot = document.getElementById('btn-screenshot');
const btnOcr = document.getElementById('btn-ocr');
const btnVideo = document.getElementById('btn-video');

let isOpen = false;
let isDragging = false;
let dragStartX, dragStartY;

// Toggle Menu
mainBtn.addEventListener('click', () => {
    if (isDragging) return; // Prevent click if we were dragging
    isOpen = !isOpen;
    if (isOpen) {
        menu.classList.add('open');
        mainBtn.classList.add('active');
        // Tell main process to expand the window bounds so menu choices are clickable
        window.api.widgetAction('expand');
    } else {
        menu.classList.remove('open');
        mainBtn.classList.remove('active');
        // Wait for animation
        setTimeout(() => {
            window.api.widgetAction('collapse');
        }, 300);
    }
});

// Implement manual drag to allow Edge Snapping in the main process
mainBtn.addEventListener('mousedown', (e) => {
    isDragging = false;
    dragStartX = e.screenX;
    dragStartY = e.screenY;

    const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.screenX - dragStartX;
        const deltaY = moveEvent.screenY - dragStartY;

        // Threshold to consider it a drag vs a click
        if (!isDragging && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
            isDragging = true;
        }

        if (isDragging) {
            // Send drag updates to main process to move the window natively
            window.api.widgetAction('drag', { x: deltaX, y: deltaY });

            // Update start variables so next frame calculates from this new point
            dragStartX = moveEvent.screenX;
            dragStartY = moveEvent.screenY;
        }
    };

    const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (isDragging) {
            // Signal drag end for edge-snapping
            window.api.widgetAction('drag-end');
        }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
});

// Action Buttons
btnSnippet.addEventListener('click', () => {
    window.api.widgetAction('open-list');
});

btnScreenshot.addEventListener('click', () => {
    window.api.widgetAction('capture-draw');
});

btnOcr.addEventListener('click', () => {
    window.api.widgetAction('capture-ocr');
});

btnVideo.addEventListener('click', () => {
    window.api.widgetAction('capture-video');
});

// Close menu when losing focus
window.addEventListener('blur', () => {
    if (isOpen) {
        isOpen = false;
        menu.classList.remove('open');
        mainBtn.classList.remove('active');
        setTimeout(() => {
            window.api.widgetAction('collapse');
        }, 300);
    }
});
