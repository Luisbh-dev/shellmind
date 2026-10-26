import type { HostKeyInfo } from '@shared/protocol';
import type { TerminalNotice } from '@shared/terminal';
import { t } from '@/i18n';
import { describeConnectionError, plainText } from '@/lib/connectionErrors';

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const line = (color: string, text: string) => `${color}${text}${RESET}\r\n`;

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return t('terminal.notice.mebibytes', { value: (bytes / (1024 * 1024)).toFixed(1) });
    return t('terminal.notice.kibibytes', { value: Math.max(1, Math.round(bytes / 1024)) });
}

// What the terminal shows for a backend notice, in the user's language.
export function formatTerminalNotice(notice: TerminalNotice): string {
    switch (notice.kind) {
        case 'connected':
            if (notice.protocol === 'ftp') return '\r\n' + line(DIM, t('terminal.notice.connectedFtp', { target: notice.target }));
            return '\r\n' + line(DIM, notice.via.length
                ? t('terminal.notice.connectedVia', { target: notice.target, via: notice.via.join(' → ') })
                : t('terminal.notice.connected', { target: notice.target }));
        case 'connection-closed': {
            const reason = notice.error ? describeConnectionError(notice.error) : notice.reason ? plainText(notice.reason) : '';
            return '\r\n' + line(DIM, reason ? t('terminal.notice.closedBecause', { reason }) : t('terminal.notice.closed'));
        }
        case 'session-ended':
            return '\r\n' + line(DIM, t('terminal.notice.sessionEnded'));
        case 'output-discarded':
            // The cut may have fallen inside a colour sequence: reset it.
            return `${RESET}\r\n` + line(DIM, t('terminal.notice.outputDiscarded', { size: formatBytes(notice.bytes) }));
        case 'cli-console':
            return line(DIM, t('terminal.notice.cliConsole', { name: notice.name, bin: notice.bin }))
                + (notice.installUrl ? line(YELLOW, t('terminal.notice.cliMissing', { bin: notice.bin, url: notice.installUrl })) : '');
        case 'cli-refused':
            switch (notice.reason) {
                case 'operator':
                    return line(YELLOW, t('terminal.notice.refused.operator', { bin: notice.bin, operator: notice.detail ?? '' }));
                case 'line-break':
                    return line(YELLOW, t('terminal.notice.refused.lineBreak', { bin: notice.bin }));
                case 'unterminated-quote':
                    return line(YELLOW, t(notice.detail === 'single' ? 'terminal.notice.refused.singleQuote' : 'terminal.notice.refused.doubleQuote'));
                case 'batch-unsafe':
                    return line(YELLOW, t('terminal.notice.refused.batchUnsafe'));
                case 'not-found':
                    return line(YELLOW, t('terminal.notice.refused.notFound', { bin: notice.bin }));
            }
    }
    return '';
}

// The line printed when a host key is pinned on first use.
export function formatTrustedKey(info: HostKeyInfo): string {
    const params = { host: info.host, port: info.port, keyType: info.keyType, fingerprint: info.fingerprint };
    return '\r\n' + line(DIM, info.via
        ? t('terminal.notice.keyTrustedVia', { ...params, via: info.via.split('>').join(' → ') })
        : t('terminal.notice.keyTrusted', params));
}
