import type { TranslateFn } from '@/i18n';
import type { RdpFailure } from './connection';

// What the user is shown for a failed connection: a translated message, the
// checks that can help, and the technical detail behind it (the code and the
// backend's or client's English text, for a bug report).

export type FailureText = { title: string; message: string; tips: string[]; technical: string | null };

// Codes with a text under rdp.errors: the gateway's (RdpErrorCode), the
// client's, and the refusals of "rdp-open" and "rdp-trust-certificate".
const KNOWN = new Set([
    'RDP_UNREACHABLE', 'RDP_TIMEOUT', 'RDP_JUMP_FAILED', 'RDP_NEGOTIATION_FAILED', 'RDP_LEGACY_SECURITY', 'RDP_TLS_FAILED',
    'RDP_PROTOCOL', 'RDP_TICKET', 'RDP_BUSY', 'RDP_INTERNAL', 'RDP_WRONG_PASSWORD', 'RDP_LOGON_FAILURE', 'RDP_ACCESS_DENIED',
    'RDP_SIGN_IN_TIMEOUT', 'RDP_GATEWAY', 'RDP_CLIENT_LOAD', 'RDP_CLIENT_ERROR', 'RDP_CONNECTION_LOST', 'RDP_BACKEND_TIMEOUT',
    'RDP_INVALID_TARGET', 'RDP_CERT_CHANGED', 'RDP_CERTIFICATE_NOT_FOUND', 'RDP_PASSWORD_REQUIRED', 'SECRET_UNREADABLE', 'JUMP_HOST', 'SERVER_NOT_FOUND',
    'UNSUPPORTED_PURPOSE', 'INVALID_SERVER_ID', 'INVALID_REQUEST'
]);

const REASONS = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']);

// The translated text of a code (rdp.errors.unknown for one ShellMind has no
// text of), for messages outside the connect screen (the trust toast).
export function failureMessage(t: TranslateFn, code: string): string {
    return KNOWN.has(code) ? t(`rdp.errors.${code}`) : t('rdp.errors.unknown');
}

export function describeFailure(t: TranslateFn, failure: RdpFailure, target: { address: string; port: number }): FailureText {
    const details = failure.details ?? {};
    const text = (value: unknown) => (value === undefined || value === null ? '' : String(value));
    const errno = text(details.errno);
    const known = KNOWN.has(failure.code);
    // The jump host's own (English) reason stays in the technical detail.
    const message = known
        ? t(`rdp.errors.${failure.code}`, {
            address: text(details.address) || target.address,
            reason: REASONS.has(errno) ? t(`rdp.errors.reasons.${errno}`) : t('rdp.errors.reasons.unknown'),
            jump: text(details.jump),
            failure: text(details.failure) || '?'
        })
        : t('rdp.errors.unknown');

    const tips: string[] = [];
    switch (failure.code) {
        case 'RDP_UNREACHABLE':
        case 'RDP_TIMEOUT':
            tips.push(t('rdp.errors.tips.port', { port: target.port }), t('rdp.errors.tips.enabled'));
            break;
        case 'RDP_JUMP_FAILED':
            tips.push(t('rdp.errors.tips.jump', { address: target.address }));
            break;
        case 'RDP_WRONG_PASSWORD':
            tips.push(t('rdp.errors.tips.credentials'));
            break;
        case 'RDP_LOGON_FAILURE':
        case 'RDP_ACCESS_DENIED':
            tips.push(t('rdp.errors.tips.credentials'), t('rdp.errors.tips.group'));
            break;
        case 'SECRET_UNREADABLE':
        case 'RDP_INVALID_TARGET':
        case 'JUMP_HOST':
            tips.push(t('rdp.errors.tips.edit'));
            break;
        default:
            break;
    }

    const lost = failure.code === 'RDP_CONNECTION_LOST';
    const technical = failure.message ? `${failure.code}: ${failure.message}` : failure.code;
    return { title: t(lost ? 'rdp.errors.lostTitle' : 'rdp.errors.title'), message, tips, technical };
}

// Why the remote desktop ended a session, in the user's language: IronRDP
// reports the server's reason in English (MS-RDPBCGR error info and
// disconnect reasons). null: none, or one ShellMind has no text of (then
// `raw` is shown as it came).
const END_REASONS: ReadonlyArray<[RegExp, string]> = [
    [/logging off/i, 'signedOut'],
    [/forced logoff/i, 'loggedOffByAdmin'],
    [/administrative tool on the server running in the user's session/i, 'disconnectedInSession'],
    [/administrative tool on the server in another session/i, 'disconnectedByAdmin'],
    [/idle session limit/i, 'idle'],
    [/active session limit/i, 'sessionLimit'],
    [/another user connected/i, 'otherUser'],
    [/insufficient access privileges/i, 'privileges'],
    [/enter their credentials for each connection/i, 'freshCredentials'],
    [/out of available memory/i, 'memory'],
    [/denied the connection/i, 'denied'],
    [/licens/i, 'licensing']
];

export function describeEndReason(t: TranslateFn, reason: string | null): { text: string | null; raw: string | null } {
    if (!reason) return { text: null, raw: null };
    const match = END_REASONS.find(([pattern]) => pattern.test(reason));
    return match ? { text: t(`rdp.ended.reasons.${match[1]}`), raw: reason } : { text: null, raw: reason };
}
