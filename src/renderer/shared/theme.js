// Interface theme, renderer side. Loaded from <head> on purpose: data-theme has to be on
// <html> before the first paint, otherwise every window flashes the dark palette on its
// way to light.
//
// Nothing else to do — the stylesheets are written against CSS tokens, and :root[data-theme]
// re-points them. Switching is therefore instant and needs no reload, which matters for the
// windows you can't reload mid-task (the snipper overlay, the recorder).
(function () {
    const applyTheme = (theme) => {
        document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
        // Lets form controls and scrollbars follow along.
        document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
    };

    applyTheme((window.api && window.api.theme && window.api.theme.resolved) || 'dark');

    if (window.api && window.api.onThemeChanged) window.api.onThemeChanged(applyTheme);
})();
