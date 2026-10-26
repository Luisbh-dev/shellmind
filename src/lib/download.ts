// Hands a Blob (or generated text) to the browser's download manager through
// a temporary object URL: no data: URL, so the size is not limited by URL
// length.

// Revoking right after click() can abort the download in some browsers
// (Firefox starts it asynchronously), so the URL is released later.
export const REVOKE_DELAY_MS = 60_000;

// Characters no file system takes in a name, and control characters.
// eslint-disable-next-line no-control-regex -- control characters are what it removes
const UNSAFE_NAME = /[\\/:*?"<>|\x00-\x1f]+/g;

// A name the download manager accepts: path separators and reserved
// characters become "_", and an empty result falls back to `fallback`.
export function safeFileName(name: string, fallback = 'download'): string {
    const clean = name.replace(UNSAFE_NAME, '_').replace(/^\.+$/, '').trim();
    return clean || fallback;
}

export function saveBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

export function saveText(name: string, content: string, type = 'text/plain'): void {
    saveBlob(new Blob([content], { type }), name);
}

// A file name stamped with the local time: "multiexec-20261023-201502".
export function exportFileName(prefix: string, at: number): string {
    const date = new Date(at);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${prefix}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
