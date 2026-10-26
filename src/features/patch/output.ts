// What ShellMind itself writes into a patch run's output (its scripts and the
// reboot step), and why a server's run failed, in the user's language. They
// come as marker lines ("[shellmind] reboot=back after=42 up=9",
// shared/patch.ts); everything else stays as the server printed it, and so
// does a marker this version does not know.
import { PATCH_MANAGERS, PATCH_MARK, parsePatchMarker, type PatchMarker } from '@shared/patch';
import type { TranslateFn } from '@/i18n';

// "42 s", "2 min 5 s", "10 min".
export function patchDuration(t: TranslateFn, seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    if (total < 120) return t('patch.output.seconds', { count: total });
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? t('patch.output.minutesSeconds', { minutes, seconds: rest }) : t('patch.output.minutes', { count: minutes });
}

const REBOOT_EVENTS = new Set(['start', 'waiting', 'skip-no-boot-id', 'skip-unknown', 'skip-jump-host']);
const ERRORS = new Set(['privilege', 'no-manager', 'no-security', 'reboot-privilege']);
const VERDICTS = new Set(['yes', 'no', 'unknown']);

function rebootBack(marker: PatchMarker, t: TranslateFn): string {
    const { after, up, state, failed } = marker.params;
    const failedCount = failed === undefined ? null : Number(failed);
    return [
        t('patch.output.reboot.back', { after: patchDuration(t, Number(after ?? 0)) }),
        up !== undefined ? t('patch.output.reboot.up', { up: patchDuration(t, Number(up)) }) : null,
        state ? t('patch.output.reboot.state', { state }) : null,
        failedCount === null ? null : failedCount === 1 ? t('patch.output.reboot.failedUnitsOne') : t('patch.output.reboot.failedUnits', { count: failedCount })
    ].filter(Boolean).join(' · ');
}

// One marker in words, or null when this version does not know it.
export function describePatchMarker(marker: PatchMarker, t: TranslateFn): string | null {
    const { event, value, params, detail } = marker;
    const duration = (name: string) => patchDuration(t, Number(params[name] ?? 0));
    switch (event) {
        case 'manager':
            return t('patch.output.manager', { manager: (PATCH_MANAGERS as readonly string[]).includes(value) ? t(`patch.managers.${value}`) : value });
        case 'refresh-failed':
            return t('patch.output.refreshFailed', { code: value });
        case 'failed':
            return t('patch.output.failed', { code: value });
        case 'security-updates':
            return value === 'none' ? t('patch.output.noSecurityUpdates') : null;
        case 'auto-marks-failed':
            return t('patch.output.autoMarksFailed', { code: value });
        case 'reboot-required':
            return VERDICTS.has(value) ? t(`patch.output.rebootRequired.${value}`) : null;
        case 'error':
            return ERRORS.has(value) ? t(`patch.output.error.${value}`, { manager: params.manager ?? '' }) : null;
        case 'reboot':
            if (value === 'back') return rebootBack(marker, t);
            if (value === 'still-waiting') return t('patch.output.reboot.stillWaiting', { after: duration('after') });
            return REBOOT_EVENTS.has(value) ? t(`patch.output.reboot.${value}`) : null;
        case 'reboot-check':
            if (value === 'state') return t('patch.output.check.state', { state: params.state ?? '' });
            if (value === 'failed-units') return t('patch.output.check.failedUnits', { before: params.before ?? '0', after: params.after ?? '0' });
            if (value === 'still-starting') return t('patch.output.check.stillStarting', { after: duration('after') });
            return null;
        case 'reboot-failed':
            switch (value) {
                case 'command': return t('patch.output.rebootFailed.command', { code: params.code ?? '' });
                case 'timeout': return [t('patch.output.rebootFailed.timeout', { wait: duration('wait') }), detail ? t('patch.output.lastAttempt', { detail }) : null].filter(Boolean).join(' ');
                case 'same-boot': return t('patch.output.rebootFailed.sameBoot', { after: duration('after') });
                case 'connection': return t('patch.output.rebootFailed.connection', { detail: detail ?? '' });
                case 'check': return t('patch.output.rebootFailed.check', { detail: detail ?? '' });
                case 'cancelled': return t('patch.output.rebootFailed.cancelled');
                default: return null;
            }
        default:
            return null;
    }
}

const MARKER_LINES = /^\[shellmind\] .*$/gm;

// A run's output with its marker lines in words (still tagged [shellmind],
// so they stand apart from what the package manager printed).
export function localizePatchText(text: string, t: TranslateFn): string {
    if (!text.includes(PATCH_MARK)) return text;
    return text.replace(MARKER_LINES, (line) => {
        const marker = parsePatchMarker(line);
        const words = marker ? describePatchMarker(marker, t) : null;
        return words === null ? line : `${PATCH_MARK} ${words}`;
    });
}

// Why a server's run failed (a marker, or the server's own text).
export function localizePatchError(error: string | null, t: TranslateFn): string | null {
    if (!error?.startsWith(PATCH_MARK)) return error;
    const marker = parsePatchMarker(error);
    return (marker && describePatchMarker(marker, t)) ?? error;
}

type RunText = { stdout: string; stderr: string; error: string | null };

const cache = new WeakMap<object, { t: TranslateFn; run: object }>();

// The servers of a patch job with their output in words. A server's run is
// worded once per language (the job view renders often while a run goes on).
export function localizePatchRuns<T extends RunText>(servers: readonly T[], t: TranslateFn): T[] {
    return servers.map((server) => {
        const known = cache.get(server);
        if (known?.t === t) return known.run as T;
        const run = { ...server, stdout: localizePatchText(server.stdout, t), stderr: localizePatchText(server.stderr, t), error: localizePatchError(server.error, t) };
        cache.set(server, { t, run });
        return run;
    });
}
