import fs from 'fs';

// The log names hosts, users and paths of the saved connections: only the
// user may read it.
const PRIVATE_MODE = 0o600;

// Append-only log file with simple size-based rotation: once it would grow
// past `maxBytes` it is renamed to `<file>.1` (replacing the previous one) and
// a new file is started. Writes are synchronous, so nothing is lost when the
// backend dies mid-line and no stream can be written after it ended.
export class RotatingLogFile {
    private fd: number | null = null;
    private size = 0;

    constructor(readonly filePath: string, private readonly maxBytes = 5 * 1024 * 1024) {}

    write(text: string): void {
        const data = Buffer.from(text, 'utf8');
        try {
            if (this.fd === null) this.open();
            if (this.size > 0 && this.size + data.length > this.maxBytes) this.rotate();
            fs.writeSync(this.fd!, data);
            this.size += data.length;
        } catch (error) {
            // Logging must never take the app down (disk full, file locked...).
            console.error(`Could not write to ${this.filePath}:`, error);
        }
    }

    close(): void {
        if (this.fd === null) return;
        fs.closeSync(this.fd);
        this.fd = null;
    }

    private open(): void {
        this.fd = fs.openSync(this.filePath, 'a', PRIVATE_MODE);
        // The mode above only applies to a new file: logs left by older
        // versions were created world-readable.
        tighten(() => fs.fchmodSync(this.fd!, PRIVATE_MODE));
        tighten(() => fs.chmodSync(`${this.filePath}.1`, PRIVATE_MODE));
        this.size = fs.fstatSync(this.fd).size;
    }

    private rotate(): void {
        this.close();
        fs.rmSync(`${this.filePath}.1`, { force: true });
        fs.renameSync(this.filePath, `${this.filePath}.1`);
        this.open();
    }
}

// Windows has no such permissions, and a missing rotated file is fine.
function tighten(change: () => void) {
    try {
        change();
    } catch {
        // Nothing to tighten.
    }
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
    // The UI is loaded with ?token=<session token>, and Electron repeats the
    // URL in its errors.
    [/([?&]token=)[^&#\s'"]+/gi, '$1[redacted]'],
    [/\b(bearer\s+)[\w.~+/=-]+/gi, '$1[redacted]']
];

// Masks session tokens in a line before it reaches the log file.
export function redactLogText(text: string): string {
    return SECRET_PATTERNS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}
