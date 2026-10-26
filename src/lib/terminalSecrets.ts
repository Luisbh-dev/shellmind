// W7-S4: secret values typed into a server's terminal (a snippet's
// {{password}}). The shell echoes them, and a command may print them, so the
// terminal's text is masked with them wherever it is read for something else
// than the screen: the AI chat's context and Auto-Run
// (src/store/terminalOutput.ts) and the terminal issues
// (src/lib/terminalIssues.ts). A line editor that wraps the echoed command
// itself breaks a value across two lines: a value is found with line breaks
// anywhere in it too.
//
// They are kept as long as the server's terminal output is (until the server
// is closed, clearTerminalOutput): its terminals keep them in their
// scrollback that long, and a terminal tab that gets the focus again feeds
// its screen back. Values shorter than MIN_MASKED_LENGTH are not looked for
// (shared/placeholders.ts).
// Relative: the Node-side tests compile this module too, through
// src/store/terminalOutput.ts (no path aliases there).
import { MIN_MASKED_LENGTH, type SecretValue } from '../../shared/placeholders';

// Per server; the oldest go first beyond this.
const MAX_SECRETS = 100;

type Known = SecretValue & { pattern: RegExp };

const secrets = new Map<number, Known[]>();

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The value, with an optional line break between any two of its characters.
const valuePattern = (value: string) => new RegExp([...value].map(escapeRegExp).join('\\r?\\n?'), 'g');

export function rememberTerminalSecrets(serverId: number, values: readonly SecretValue[]): void {
    const added = values.filter((secret) => secret.value.length >= MIN_MASKED_LENGTH);
    if (!added.length) return;
    const known = (secrets.get(serverId) ?? []).filter((secret) => !added.some((item) => item.value === secret.value));
    const next = [...known, ...added.map((secret) => ({ ...secret, pattern: valuePattern(secret.value) }))].slice(-MAX_SECRETS);
    // Longest first, so a value that contains another is masked whole.
    secrets.set(serverId, next.sort((a, b) => b.value.length - a.value.length));
}

// `text` of the terminal of `serverId` with its secret values replaced by
// their {{placeholder}}.
export function maskTerminalSecrets(serverId: number, text: string): string {
    let result = text;
    for (const { name, pattern } of secrets.get(serverId) ?? []) result = result.replace(pattern, `{{${name}}}`);
    return result;
}

export function forgetTerminalSecrets(serverId: number): void {
    secrets.delete(serverId);
}
