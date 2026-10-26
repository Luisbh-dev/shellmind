import { describe, expect, it } from 'vitest';
import { FTPError } from 'basic-ftp';
import { ftpError } from './ftpFs';
import { FsError } from './remoteFs';

const reply = (code: number, message: string) => new FTPError({ code, message: `${code} ${message}` });

describe('ftpError', () => {
    it('maps FTP replies to file error codes', () => {
        expect(ftpError(reply(550, 'No such file or directory'), '/a').code).toBe('NOT_FOUND');
        expect(ftpError(reply(550, 'Permission denied'), '/a').code).toBe('PERMISSION_DENIED');
        expect(ftpError(reply(553, 'Could not create file'), '/a')).toMatchObject({ code: 'FAILED', message: '/a: 553 Could not create file' });
        expect(ftpError(reply(530, 'Login incorrect'), '/a').code).toBe('PERMISSION_DENIED');
        expect(ftpError(reply(421, 'Timeout'), '/a').code).toBe('NOT_CONNECTED');
    });

    it('explains closed connections, timeouts and refused passive hosts', () => {
        expect(ftpError(new Error('Client is closed because Server sent FIN packet unexpectedly'), '/a').code).toBe('NOT_CONNECTED');
        expect(ftpError(new Error('Timeout (control socket)'), '/a').code).toBe('TIMEOUT');
        expect(ftpError(new Error('PASV returned another host (10.0.0.5) for data transfer that you have connected to (203.0.113.9).'), '/a'))
            .toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('EPSV') });
    });

    it('passes file errors through', () => {
        const original = new FsError('TOO_LARGE', 'too big');
        expect(ftpError(original, '/a')).toBe(original);
    });
});
