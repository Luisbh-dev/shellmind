import { describe, expect, it } from 'vitest';
import { translate } from '@/i18n/catalog';
import { ApiError } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { describeLastError, describeProblem, problemFromError, problemText, tunnelName } from './format';

const en = (key: string, params?: Record<string, string | number>) => translate('en', key, params);
const es = (key: string, params?: Record<string, string | number>) => translate('es', key, params);
const endpoints = { name: null, local_host: '127.0.0.1', local_port: 15432, remote_host: 'db.internal', remote_port: 5432 };

describe('tunnel formatting', () => {
    it('formats byte counts per language', () => {
        expect(formatBytes(0, 'en')).toBe('0 B');
        expect(formatBytes(1023, 'en')).toBe('1,023 B');
        expect(formatBytes(1536, 'en')).toBe('1.5 KB');
        expect(formatBytes(1536, 'es')).toBe('1,5 KB');
        expect(formatBytes(200 * 1024 * 1024, 'en')).toBe('200 MB');
        expect(formatBytes(3 * 1024 ** 3, 'en')).toBe('3 GB');
    });

    it('names a tunnel after its name, its service or its remote address', () => {
        expect(tunnelName({ ...endpoints, name: 'Prod DB' })).toBe('Prod DB');
        expect(tunnelName(endpoints)).toBe('PostgreSQL');
        expect(tunnelName({ ...endpoints, remote_port: 9999 })).toBe('db.internal:9999');
    });

    it('explains known failures in the user language and keeps the precise reason', () => {
        expect(describeProblem(en, 'PORT_IN_USE', 'raw', endpoints)).toEqual({
            text: 'Local port 15432 is already in use. Pick another local port, or stop the program or tunnel using it.',
        });
        expect(describeProblem(en, 'REMOTE_UNREACHABLE', 'The server could not connect to db.internal:5432: Connection refused', endpoints)).toEqual({
            text: 'The server could not reach db.internal:5432. Is the service running and listening there?',
            detail: 'The server could not connect to db.internal:5432: Connection refused',
        });
        expect(describeProblem(en, 'SOMETHING_NEW', 'As the backend says', endpoints)).toEqual({ text: 'As the backend says' });
        expect(describeProblem(en, undefined, 'No code', endpoints)).toEqual({ text: 'No code' });
    });

    it('reads the code of API errors', () => {
        const err = new ApiError(502, 'Could not open the SSH connection: Auth failed', { error: 'x', code: 'SSH_CONNECT_FAILED' });
        expect(problemFromError(en, err, endpoints)).toEqual({
            text: 'Could not connect to the server over SSH.',
            detail: 'Could not open the SSH connection: Auth failed',
        });
        expect(problemFromError(en, new Error('offline'), endpoints)).toEqual({ text: 'offline' });
    });

    it('explains the address a failure was about, and the tunnel that holds a port', () => {
        // The tunnel was moved to 15433 since it failed on 15432.
        const moved = { ...endpoints, local_port: 15433 };
        const error = { code: 'PORT_IN_USE', message: 'raw', at: 0, details: { host: '127.0.0.1', port: 15432 } };
        expect(describeLastError(en, error, moved).text).toMatch(/^Local port 15432 is already in use/);
        expect(describeLastError(en, { ...error, details: { port: 15432, tunnelId: 3, tunnelName: 'db primary' } }, moved)).toEqual({
            text: 'Local port 15432 is already used by the tunnel “db primary”. Stop that tunnel or pick another local port.',
        });
        expect(describeLastError(es, { ...error, details: { port: 15432, tunnelId: 3, tunnelName: 'db primary' } }, moved).text)
            .toBe('El puerto local 15432 ya lo usa el túnel «db primary». Detén ese túnel o elige otro puerto local.');
    });

    it('tells a server that refuses port forwarding apart from an unreachable service', () => {
        // OpenSSH only says "open failed": the headline says it all.
        const message = 'The SSH server does not allow forwarding to db.internal:5432 (AllowTcpForwarding / PermitOpen): open failed';
        expect(describeProblem(en, 'FORWARDING_DENIED', message, endpoints)).toEqual({
            text: 'The SSH server does not allow port forwarding to db.internal:5432. Ask its administrator to enable it for your account (AllowTcpForwarding, PermitOpen in sshd_config).',
        });
    });

    it('names the invalid field in the user language instead of the backend message', () => {
        const err = new ApiError(400, 'local_host must be an IP address of this machine, such as 127.0.0.1', {
            error: 'x', code: 'INVALID_TUNNEL', details: { field: 'local_host' },
        });
        expect(problemFromError(es, err, endpoints)).toEqual({ text: 'El valor de «Dirección de escucha» no es válido.' });
        expect(problemFromError(en, err, endpoints)).toEqual({ text: 'The value of “Listen address” is not valid.' });
        expect(problemFromError(en, new ApiError(400, 'x', { error: 'x', code: 'INVALID_TUNNEL' }), endpoints)).toEqual({ text: 'The tunnel settings are not valid.' });
        const unconfirmed = new ApiError(409, 'x', { error: 'x', code: 'PUBLIC_BIND_UNCONFIRMED', details: { local_host: '0.0.0.0' } });
        expect(problemFromError(es, unconfirmed, endpoints).text).toMatch(/^Escuchar en 0\.0\.0\.0 permite/);
    });

    it('explains connection target failures, keeping the precise reason where it helps', () => {
        expect(describeProblem(es, 'UNSUPPORTED_PURPOSE', 'A ftp server does not support exec connections.', endpoints)).toEqual({
            text: 'Este servidor ya no es un servidor SSH, así que sus túneles no pueden conectarse. Vuelve a cambiar su tipo a Linux o Windows.',
        });
        expect(describeProblem(en, 'PRIVATE_KEY_FILE', 'Cannot read the private key file /k: ENOENT', endpoints)).toEqual({
            text: 'The private key file of this server cannot be read.',
            detail: 'Cannot read the private key file /k: ENOENT',
        });
        expect(describeProblem(en, 'JUMP_HOST', 'The jump server of "web" no longer exists.', endpoints).detail).toBe('The jump server of "web" no longer exists.');
        expect(describeProblem(en, 'TUNNEL_START_CANCELLED', 'raw', endpoints)).toEqual({
            text: 'The tunnel was stopped or its settings changed while it was starting.',
        });
        expect(problemText({ text: 'Headline.', detail: 'Reason.' })).toBe('Headline. Reason.');
    });
});
