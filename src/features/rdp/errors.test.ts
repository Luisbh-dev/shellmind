import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '@/i18n';
import { describeEndReason, describeFailure, failureMessage } from './errors';

const target = { address: '10.0.0.9:3389', port: 3389 };

beforeEach(() => setLanguage('en'));
afterEach(() => setLanguage('system'));

describe('describeFailure', () => {
    it('translates gateway failures with their details and checks', () => {
        const text = describeFailure(t, { code: 'RDP_UNREACHABLE', message: 'Could not connect…', details: { address: '10.0.0.9:3389', errno: 'ECONNREFUSED' } }, target);
        expect(text.message).toBe('10.0.0.9:3389 could not be reached (connection refused).');
        expect(text.tips).toHaveLength(2);
        expect(text.tips[0]).toContain('Port 3389');
        expect(text.technical).toBe('RDP_UNREACHABLE: Could not connect…');
        expect(describeFailure(t, { code: 'RDP_NEGOTIATION_FAILED', details: { failure: 'HYBRID_REQUIRED_BY_SERVER' } }, target).message)
            .toBe('The server refused the security settings (HYBRID_REQUIRED_BY_SERVER).');
        // The jump host's own (English) reason is the technical detail.
        const jump = describeFailure(t, { code: 'RDP_JUMP_FAILED', message: 'The jump host bastion could not reach x: Connection refused', details: { jump: 'bastion', reason: 'Connection refused' } }, target);
        expect(jump.message).toBe('The jump host bastion could not open the connection to the server.');
        expect(jump.technical).toBe('RDP_JUMP_FAILED: The jump host bastion could not reach x: Connection refused');
    });

    it('explains sign-in failures', () => {
        const text = describeFailure(t, { code: 'RDP_ACCESS_DENIED' }, target);
        expect(text.message).toMatch(/Remote Desktop Users/);
        expect(text.tips).toHaveLength(2);
        expect(describeFailure(t, { code: 'RDP_CONNECTION_LOST', message: 'socket closed' }, target).title).toBe('Connection lost');
    });

    it('translates the refusals of the backend, keeping its words as the technical detail', () => {
        const text = describeFailure(t, { code: 'SECRET_UNREADABLE', message: 'The saved password of "win" cannot be decrypted.' }, target);
        expect(text.message).toBe('The saved password cannot be decrypted with the current data key.');
        expect(text.tips).toEqual(['Fix it in the connection settings: right-click the server in the list › Edit.']);
        expect(text.technical).toBe('SECRET_UNREADABLE: The saved password of "win" cannot be decrypted.');
        for (const code of ['RDP_INVALID_TARGET', 'JUMP_HOST', 'SERVER_NOT_FOUND', 'INVALID_REQUEST', 'RDP_CERT_CHANGED', 'RDP_PASSWORD_REQUIRED']) {
            expect(describeFailure(t, { code, message: 'English text' }, target).message).not.toBe('English text');
        }
        // A code ShellMind has no text of: a translated message, the rest as detail.
        const unknown = describeFailure(t, { code: 'SOMETHING_NEW', message: 'Backend words' }, target);
        expect(unknown.message).toBe('Something went wrong while preparing the connection.');
        expect(unknown.technical).toBe('SOMETHING_NEW: Backend words');
        expect(failureMessage(t, 'RDP_CERT_CHANGED')).toBe('The server presents another certificate by now. Connect again to compare the current one.');
    });

    it('speaks Spanish too, also for the backend’s refusals', () => {
        setLanguage('es');
        expect(describeFailure(t, { code: 'RDP_UNREACHABLE', details: { errno: 'ETIMEDOUT' } }, target).message)
            .toBe('No se pudo llegar a 10.0.0.9:3389 (tiempo de espera agotado).');
        expect(describeFailure(t, { code: 'RDP_INVALID_TARGET', message: 'The user name or domain contains characters Remote Desktop cannot use.' }, target).message)
            .toBe('La dirección, el puerto, el usuario o el dominio de esta conexión no se pueden usar con Escritorio remoto.');
        expect(describeFailure(t, { code: 'SOMETHING_NEW' }, target).message).toBe('Algo ha fallado al preparar la conexión.');
        expect(failureMessage(t, 'RDP_CERT_CHANGED')).toBe('El servidor ya presenta otro certificado. Vuelve a conectar para comparar el actual.');
    });
});

describe('describeEndReason', () => {
    it('translates the reasons Windows gives for ending a session', () => {
        expect(describeEndReason(t, 'The disconnection was initiated by the user logging off his or her session on the server'))
            .toEqual({ text: 'You signed out of Windows.', raw: 'The disconnection was initiated by the user logging off his or her session on the server' });
        expect(describeEndReason(t, 'server initiated disconnect (The idle session limit timer on the server has elapsed)').text)
            .toBe('The session was idle for longer than the server allows.');
        expect(describeEndReason(t, 'Another user connected to the server, forcing the disconnection of the current connection').text).toMatch(/Someone else signed in/);
        setLanguage('es');
        expect(describeEndReason(t, 'The disconnection was initiated by an administrative tool on the server in another session').text)
            .toBe('Un administrador ha desconectado esta sesión. Sigue abierta hasta que cierres sesión.');
    });

    it('keeps an unknown reason as it came, and has nothing for none', () => {
        expect(describeEndReason(t, 'channel purged')).toEqual({ text: null, raw: 'channel purged' });
        expect(describeEndReason(t, null)).toEqual({ text: null, raw: null });
    });
});
