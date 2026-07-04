const { ipcMain } = require('electron');
const { state, store } = require('../state');
const { toggleWidget, handleWidgetAction, updateWidgetScale } = require('../window-manager');

// Floating widget settings + actions.
function registerWidgetHandlers() {
    ipcMain.on('set-show-widget', (e, v) => {
        state.showWidget = v;
        store.set('showWidget', v);
        toggleWidget(v);
    });

    ipcMain.on('set-widget-transparent', (e, v) => {
        state.widgetTransparent = v;
        store.set('widgetTransparent', v);
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.webContents.send('widget-config', {
                transparent: v, color: state.widgetColor, opacity: state.widgetOpacity
            });
        }
    });

    ipcMain.on('set-widget-color', (e, v) => {
        state.widgetColor = v;
        store.set('widgetColor', v);
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.webContents.send('widget-config', {
                transparent: state.widgetTransparent, color: v, opacity: state.widgetOpacity
            });
        }
    });

    ipcMain.on('set-widget-opacity', (e, v) => {
        state.widgetOpacity = v;
        store.set('widgetOpacity', v);
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.webContents.send('widget-config', {
                transparent: state.widgetTransparent, color: state.widgetColor, opacity: v, scale: state.widgetScale
            });
        }
    });

    ipcMain.on('set-widget-scale', (e, v) => {
        state.widgetScale = v;
        store.set('widgetScale', v);
        updateWidgetScale(v);
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.webContents.send('widget-config', {
                transparent: state.widgetTransparent, color: state.widgetColor, opacity: state.widgetOpacity, scale: v
            });
        }
    });

    ipcMain.on('widget-action', (e, action, data) => {
        handleWidgetAction(action, data);
    });
}

module.exports = { registerWidgetHandlers };
