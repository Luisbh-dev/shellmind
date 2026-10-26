// The system clipboard. navigator.clipboard only exists in secure contexts
// (https, localhost, Electron): a self-hosted instance opened over plain
// http on the LAN has none, so callers get a clear rejection instead of a
// TypeError.

export class ClipboardUnavailableError extends Error {
    constructor() {
        super('Clipboard unavailable');
        this.name = 'ClipboardUnavailableError';
    }
}

export function canUseClipboard(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
}

// Rejects when the clipboard is unavailable or the permission is denied.
export async function copyText(text: string): Promise<void> {
    if (!canUseClipboard()) throw new ClipboardUnavailableError();
    await navigator.clipboard.writeText(text);
}

export async function readClipboardText(): Promise<string> {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.readText !== 'function') throw new ClipboardUnavailableError();
    return navigator.clipboard.readText();
}
