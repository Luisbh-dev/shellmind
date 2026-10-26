// Where the UI runs: the desktop app (Electron) or a browser tab (self-hosted
// web mode). Browsers keep some shortcuts for themselves (Ctrl+Shift+T,
// Ctrl+Shift+W), and only the desktop app draws its own title bar.
export function isDesktopApp(): boolean {
    if (typeof navigator === 'undefined') return false;
    return navigator.userAgent.toLowerCase().includes(' electron/')
        || (typeof location !== 'undefined' && location.protocol === 'file:');
}
