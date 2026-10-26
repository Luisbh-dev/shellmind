// URL policy of the main window. Kept free of Electron imports so it can be
// unit-tested.

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

// The URL to hand to the OS browser/mail client, or null for anything else
// (file:, UNC paths, ms-* and other protocol handlers are never opened).
export function externalUrl(raw: string): string | null {
    try {
        const url = new URL(raw);
        return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

// Whether `target` is the app itself: the same file (query and hash ignored)
// for the packaged build, the same origin for the Vite dev server.
export function isAppUrl(target: string, appUrl: string, caseInsensitivePaths = process.platform === 'win32'): boolean {
    let url: URL;
    let app: URL;
    try {
        url = new URL(target);
        app = new URL(appUrl);
    } catch {
        return false;
    }
    if (url.protocol !== app.protocol) return false;
    if (app.protocol !== 'file:') return url.origin === app.origin;

    const normalize = (pathname: string) => {
        const decoded = decodeURIComponent(pathname);
        return caseInsensitivePaths ? decoded.toLowerCase() : decoded;
    };
    return url.host === app.host && normalize(url.pathname) === normalize(app.pathname);
}
