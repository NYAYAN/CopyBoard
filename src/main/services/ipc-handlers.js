const { registerCoreHandlers } = require('./ipc/core-handlers');
const { registerShortcutHandlers } = require('./ipc/shortcuts');
const { registerClipboardHandlers } = require('./ipc/clipboard-handlers');
const { registerWidgetHandlers } = require('./ipc/widget-handlers');
const { registerCaptureHandlers } = require('./ipc/capture-handlers');
const { registerUpdateHandlers } = require('./ipc/update-handlers');

function registerIpcHandlers() {
    registerCoreHandlers();
    registerShortcutHandlers();
    registerClipboardHandlers();
    registerWidgetHandlers();
    registerCaptureHandlers();
    registerUpdateHandlers();
}

module.exports = { registerIpcHandlers };
