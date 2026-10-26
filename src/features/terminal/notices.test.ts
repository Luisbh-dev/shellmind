import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalNotice } from '@shared/terminal';
import { setLanguage } from '@/i18n';
import { formatTerminalNotice, formatTrustedKey } from './notices';

// Backend notices as the terminal shows them, in the user's language.

// eslint-disable-next-line no-control-regex -- the formatter colors its lines
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '').trim();

const NOTICES: TerminalNotice[] = [
    { kind: 'connected', target: 'web:22', via: [] },
    { kind: 'connected', target: 'db:22', via: ['bastion:22'] },
    { kind: 'connection-closed' },
    { kind: 'connection-closed', reason: 'read ECONNRESET' },
    { kind: 'session-ended' },
    { kind: 'cli-console', name: 'Docker', bin: 'docker' },
    { kind: 'cli-console', name: 'Azure', bin: 'az', installUrl: 'https://aka.ms/azcli' },
    { kind: 'cli-refused', bin: 'docker', reason: 'operator', detail: '|' },
    { kind: 'cli-refused', bin: 'docker', reason: 'line-break' },
    { kind: 'cli-refused', bin: 'docker', reason: 'unterminated-quote', detail: 'single' },
    { kind: 'cli-refused', bin: 'docker', reason: 'unterminated-quote', detail: 'double' },
    { kind: 'cli-refused', bin: 'az', reason: 'batch-unsafe' },
    { kind: 'cli-refused', bin: 'az', reason: 'not-found' },
    { kind: 'connected', protocol: 'ftp', target: 'files:21', via: [] },
    { kind: 'connection-closed', reason: 'Keepalive timeout', error: { code: 'KEEPALIVE_TIMEOUT', message: 'Keepalive timeout' } },
    { kind: 'output-discarded', bytes: 3 * 1024 * 1024 },
    { kind: 'output-discarded', bytes: 300 }
];

afterEach(() => {
    setLanguage('system');
});

describe('terminal notices', () => {
    it('are written in English', () => {
        setLanguage('en');
        expect(NOTICES.map((notice) => plain(formatTerminalNotice(notice)))).toEqual([
            'Connected to web:22',
            'Connected to db:22 via bastion:22',
            'Connection closed.',
            'Connection closed (read ECONNRESET).',
            '[ShellMind] Session ended.',
            'Docker console: type docker subcommands (no "docker" needed). Tab completes, ↑/↓ recall history, "exit" closes it.',
            'Azure console: type az subcommands (no "az" needed). Tab completes, ↑/↓ recall history, "exit" closes it.\r\n"az" was not found on PATH. Install it: https://aka.ms/azcli',
            'This console only runs docker commands: pipes, redirections and chaining ("|") are not available. Quote the character if it is part of an argument, or open a shell connection for a full shell.',
            'This console only runs one docker command per line. Send the lines one by one, or open a shell connection for a full shell.',
            'A single quote is not closed.',
            'A double quote is not closed.',
            'The characters % and ! and line breaks cannot be passed safely to this Windows batch tool; remove them from the arguments.',
            'az: not found on PATH.',
            'Connected to the FTP server files:21',
            'Connection closed (The connection stopped responding.).',
            '[ShellMind] 3.0 MiB of output skipped after the interrupt (Ctrl+C).',
            '[ShellMind] 1 KiB of output skipped after the interrupt (Ctrl+C).'
        ]);
        expect(plain(formatTrustedKey({ host: '10.0.0.5', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc', via: 'a:22>b:22' })))
            .toBe('Trusted the ssh-ed25519 host key of 10.0.0.5:22 (via a:22 → b:22) on first use (SHA256:abc).');
    });

    it('reset the colours after output was cut off', () => {
        expect(formatTerminalNotice({ kind: 'output-discarded', bytes: 2048 }).startsWith('\x1b[0m')).toBe(true);
    });

    it('are written in Spanish, with no key left untranslated', () => {
        setLanguage('es');
        const texts = NOTICES.map((notice) => plain(formatTerminalNotice(notice)));
        expect(texts[0]).toBe('Conectado a web:22');
        expect(texts[4]).toBe('[ShellMind] Sesión terminada.');
        expect(texts[13]).toBe('Conectado al servidor FTP files:21');
        expect(texts[14]).toBe('Conexión cerrada (La conexión ha dejado de responder.).');
        for (const text of texts) expect(text).not.toMatch(/terminal\.notice|\{\w+\}/);
        expect(plain(formatTrustedKey({ host: 'web', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' })))
            .toBe('Se ha confiado en la clave de host ssh-ed25519 de web:22 en la primera conexión (SHA256:abc).');
    });
});
