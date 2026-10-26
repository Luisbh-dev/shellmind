import { describe, expect, it } from 'vitest';
import { ConnectionTargetError } from '../connections/target';
import { AppError } from '../errors';
import { connectionError, sshFailure } from './connectionErrors';
import { ExecOutputTooLargeError } from './exec';
import { HostKeyMismatchError } from './hostKeys';

const withProps = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);

describe('connectionError', () => {
    it('gives every connection failure a code the client can translate', () => {
        expect(connectionError(withProps('All configured authentication methods failed', { level: 'client-authentication' })))
            .toEqual({ code: 'AUTH_FAILED', message: 'Auth failed: the saved credentials were rejected.' });
        expect(connectionError(withProps('x', { level: 'client-authentication', methods: ['publickey', 'keyboard-interactive'] })))
            .toMatchObject({ code: 'AUTH_FAILED', details: { methods: 'publickey, keyboard-interactive' } });
        expect(connectionError(withProps('Timed out while waiting for handshake', { level: 'client-timeout' })).code).toBe('HANDSHAKE_TIMEOUT');
        expect(connectionError(withProps('Keepalive timeout', { level: 'client-timeout' })).code).toBe('KEEPALIVE_TIMEOUT');
        expect(connectionError(withProps("Error while looking up IPv4 address for 'nope'", { level: 'client-dns' })).code).toBe('DNS_FAILED');
        expect(connectionError(withProps('connect ECONNREFUSED 127.0.0.1:1', { code: 'ECONNREFUSED', level: 'client-socket' })))
            .toEqual({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' });
        expect(connectionError(new Error('Cannot parse privateKey: Unsupported key format')).code).toBe('PRIVATE_KEY_INVALID');
        expect(connectionError(withProps('Handshake failed: no matching key exchange algorithm', { level: 'handshake' })).code).toBe('HANDSHAKE_FAILED');
        expect(connectionError(new Error('something odd'))).toEqual({ code: 'SSH_FAILED', message: 'something odd' });
    });

    it('keeps the codes and details of the backend errors', () => {
        expect(connectionError(new ConnectionTargetError('SECRET_UNREADABLE', 'The saved password of "web" cannot be decrypted')))
            .toEqual({ code: 'SECRET_UNREADABLE', message: 'The saved password of "web" cannot be decrypted' });
        expect(connectionError(new ExecOutputTooLargeError(16 * 1024 * 1024))).toMatchObject({ code: 'EXEC_OUTPUT_TOO_LARGE', details: { maxBytes: 16777216 } });
        expect(connectionError(new AppError('X', 'y', 400, { nested: { no: 1 }, list: ['a', 'b'], n: 2 })))
            .toEqual({ code: 'X', message: 'y', details: { list: 'a, b', n: 2 } });
        expect(connectionError(withProps('The jump host could not reach 10.0.0.5:22 within 20s', { code: 'JUMP_TIMEOUT', details: { target: '10.0.0.5:22', seconds: 20 } })))
            .toMatchObject({ code: 'JUMP_TIMEOUT', details: { target: '10.0.0.5:22', seconds: 20 } });
        const mismatch = new HostKeyMismatchError('10.0.0.5', 22, 'ssh-ed25519', 'SHA256:a', 'SHA256:b', 'bastion:22');
        expect(connectionError(mismatch)).toMatchObject({ code: 'HOST_KEY_MISMATCH', details: { host: '10.0.0.5', port: 22, via: 'bastion:22' } });
    });
});

describe('sshFailure', () => {
    it('gives an SSH_FAILED answer the cause the client can word', () => {
        expect(sshFailure(withProps('All configured authentication methods failed', { level: 'client-authentication' })))
            .toEqual({ message: 'Auth failed: the saved credentials were rejected.', connection: { code: 'AUTH_FAILED' } });
        expect(sshFailure(withProps('connect ECONNREFUSED 127.0.0.1:1', { code: 'ECONNREFUSED', level: 'client-socket' })))
            .toEqual({ message: 'connect ECONNREFUSED 127.0.0.1:1', connection: { code: 'ECONNREFUSED' } });
        expect(sshFailure(withProps('The jump host could not reach 10.0.0.5:22 within 20s', { code: 'JUMP_TIMEOUT', details: { target: '10.0.0.5:22', seconds: 20 } })))
            .toEqual({ message: 'The jump host could not reach 10.0.0.5:22 within 20s', connection: { code: 'JUMP_TIMEOUT', details: { target: '10.0.0.5:22', seconds: 20 } } });
        // Nothing more precise than SSH_FAILED: the message alone.
        expect(sshFailure(new Error('something odd'))).toEqual({ message: 'something odd' });
    });
});
