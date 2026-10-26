import { isSensitiveVariable, type VariableValues } from './placeholders';

// Per-device conveniences kept in localStorage: the values last used for a
// snippet's variables, and whether the starter snippets were dismissed.
// Storage may be unavailable (privacy modes): then nothing is remembered.
// The values of secret variables (declared, secret-looking or marked by the
// user, `secret`) are never written to the device.

const VALUES_PREFIX = 'shellmind.snippets.values.';
const STARTERS_DISMISSED = 'shellmind.snippets.startersDismissed';

function read(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string | null): void {
    try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
    } catch {
        // Not remembered.
    }
}

export function loadLastValues(snippetId: number): VariableValues {
    const raw = read(`${VALUES_PREFIX}${snippetId}`);
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        // Sensitive values saved by an earlier version are not offered again.
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] =>
            typeof entry[1] === 'string' && !isSensitiveVariable(entry[0])));
    } catch {
        return {};
    }
}

// Only non-empty values are kept (an empty one means "use the default"), and
// never those of secret variables.
export function saveLastValues(snippetId: number, values: VariableValues, secret: ReadonlySet<string> = new Set()): void {
    const kept = Object.fromEntries(Object.entries(values).filter(([name, value]) => value !== '' && !secret.has(name) && !isSensitiveVariable(name)));
    write(`${VALUES_PREFIX}${snippetId}`, Object.keys(kept).length ? JSON.stringify(kept) : null);
}

export function forgetLastValues(snippetId: number): void {
    write(`${VALUES_PREFIX}${snippetId}`, null);
}

export function startersDismissed(): boolean {
    return read(STARTERS_DISMISSED) === '1';
}

export function dismissStarters(): void {
    write(STARTERS_DISMISSED, '1');
}
