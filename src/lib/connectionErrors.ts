import type { ConnectionError } from '@shared/terminal';
import { getLanguage, t, type TranslateFn } from '@/i18n';
import { catalog } from '@/i18n/catalog';

// Connection failures in the user's language: the coded error of the
// terminal and file sessions ("ssh-error", "connection-closed") and the cause
// of an SSH_FAILED status, operations or log answer. Codes the client knows
// get their text (filled in from the details); any other one shows the
// backend's English message.

// Some codes read differently depending on their details.
function variant(error: ConnectionError): string {
    const details = error.details ?? {};
    if (error.code === 'AUTH_FAILED' && details.methods) return 'AUTH_FAILED_METHODS';
    if (error.code === 'JUMP_TIMEOUT' && details.jump) return 'JUMP_TIMEOUT_JUMP';
    if (error.code === 'CHANNEL_TIMEOUT' && details.what === 'files') return 'CHANNEL_TIMEOUT_FILES';
    return error.code;
}

// Control characters in text from the network (a server's error message)
// must not reach the terminal as escape sequences.
// eslint-disable-next-line no-control-regex -- that is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function plainText(text: string): string {
    return text.replace(CONTROL, ' ');
}

export function hasConnectionErrorText(error: ConnectionError): boolean {
    const key = `terminal.connectionErrors.${variant(error)}`;
    return catalog[getLanguage()]?.[key] !== undefined || catalog.en?.[key] !== undefined;
}

export function describeConnectionError(error: ConnectionError, translate: TranslateFn = t): string {
    if (!hasConnectionErrorText(error)) return plainText(error.message);
    const params: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(error.details ?? {})) params[name] = typeof value === 'string' ? plainText(value) : value;
    return translate(`terminal.connectionErrors.${variant(error)}`, params);
}
