import { describe, expect, it } from 'vitest';
import { translate } from '@/i18n/catalog';
import { ApiError } from './api';
import { connectionCause, describeCode, describeError } from './remoteErrors';

const es = (key: string, params?: Record<string, string | number>) => translate('es', key, params);

describe('remote error descriptions', () => {
    it('translates the codes of the API error envelope, keeping the backend text as the detail', () => {
        const missing = new ApiError(404, 'Server #9 does not exist (it may have been deleted).', { error: 'Server #9 does not exist (it may have been deleted).', code: 'SERVER_NOT_FOUND' });
        expect(describeError(missing, es)).toEqual({
            title: 'Este servidor ya no existe.',
            detail: 'Server #9 does not exist (it may have been deleted).',
            code: 'SERVER_NOT_FOUND',
        });
        expect(describeCode('UNSUPPORTED_PURPOSE', 'Status dashboard is only available for SSH-capable servers.', es).title)
            .toBe('No está disponible para este tipo de servidor.');
        expect(describeCode('INTERNAL', 'Internal server error.', es).title).toBe('El backend ha sufrido un error inesperado; su log tiene los detalles.');
    });

    it('says why a connection failed, in the words the terminal uses', () => {
        const refused = new ApiError(502, 'Auth failed: the saved credentials were rejected.', {
            error: 'Auth failed: the saved credentials were rejected.', code: 'SSH_FAILED', details: { connection: { code: 'AUTH_FAILED' } },
        });
        expect(describeError(refused, es)).toEqual({
            title: 'No se pudo conectar con el servidor.',
            detail: 'El servidor ha rechazado las credenciales guardadas.',
            code: 'SSH_FAILED',
        });
        expect(connectionCause(new ApiError(502, 'x', { code: 'SSH_FAILED', details: { connection: { code: 'JUMP_TIMEOUT', details: { jump: 'bastion:22', seconds: 20, odd: {} } } } })))
            .toEqual({ code: 'JUMP_TIMEOUT', details: { jump: 'bastion:22', seconds: 20 } });
        expect(describeCode('SSH_FAILED', 'connect ECONNREFUSED 10.0.0.5:22', es, { code: 'ECONNREFUSED' }).detail)
            .toBe('El servidor ha rechazado la conexión: no hay nada escuchando en ese puerto.');
        // A cause the client has no words for keeps the backend text.
        expect(describeCode('SSH_FAILED', 'Socket is closed', es, { code: 'ERR_SOMETHING' }).detail).toBe('Socket is closed');
        // Without a cause, the detail is the backend text, as before.
        expect(describeCode('SSH_FAILED', 'something odd', es).detail).toBe('something odd');
        expect(connectionCause(new ApiError(502, 'x', { code: 'SSH_FAILED', details: { connection: 'AUTH_FAILED' } }))).toBeNull();
    });

    it('translates the failures of a remote command', () => {
        expect(describeCode('EXEC_OUTPUT_TOO_LARGE', 'The command printed more than 16 MiB of output and was stopped.', es))
            .toEqual({ title: 'El comando ha mostrado demasiada salida y se ha detenido.', detail: 'The command printed more than 16 MiB of output and was stopped.', code: 'EXEC_OUTPUT_TOO_LARGE' });
        expect(describeCode('SSH_CHANNEL_REFUSED', 'The server refused to open another channel', es).title).toMatch(/^El servidor ha rechazado otra sesión/);
        expect(describeCode('EXEC_ABORTED', 'The command was cancelled', es).title).toBe('Se ha cancelado el comando.');
    });

    it('falls back to the backend message for a code it does not know', () => {
        expect(describeCode('SOMETHING_NEW', 'raw text', es)).toEqual({ title: 'raw text', detail: null, code: 'SOMETHING_NEW' });
        expect(describeError(new ApiError(0, 'Network down'), es)).toEqual({ title: 'Network down', detail: null, code: null });
    });
});
