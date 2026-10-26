import { describe, expect, it } from 'vitest';
import { failure, ftpError } from './terminalErrors';

const withProps = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);

describe('failure / ftpError', () => {
    it('codes local, S3 and FTP failures with their reason', () => {
        expect(failure('LOCAL_SPAWN_FAILED', new Error('spawn nope ENOENT'))).toEqual({
            code: 'LOCAL_SPAWN_FAILED', message: 'spawn nope ENOENT', details: { reason: 'spawn nope ENOENT' },
        });
        expect(ftpError(withProps('connect ECONNREFUSED 127.0.0.1:21 (control socket)', { code: 'ECONNREFUSED' })).code).toBe('ECONNREFUSED');
        expect(ftpError(withProps('530 Login incorrect.', { code: 530 })).code).toBe('AUTH_FAILED');
        expect(ftpError(withProps('550 No such file', { code: 550 })).code).toBe('FTP_REJECTED');
        expect(ftpError(new Error('Timeout (control socket)')).code).toBe('FTP_FAILED');
    });
});
