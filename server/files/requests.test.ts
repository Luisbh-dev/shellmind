import { describe, expect, it, vi } from 'vitest';
import { FsError } from './remoteFs';
import { parseBytes, parseItems, parsePath, parseVersion, respond } from './requests';

describe('request validation', () => {
    it('accepts absolute paths and normalizes them', () => {
        expect(parsePath('/srv//app/../web/')).toBe('/srv/web');
    });

    it('refuses relative paths, control characters and non-strings', () => {
        for (const bad of ['relative', '', '/a\r\nDELE /b', '/a\0b', 42, null, undefined, '/'.padEnd(5000, 'x')]) {
            expect(() => parsePath(bad)).toThrow(FsError);
        }
    });

    it('parses item lists and refuses the root', () => {
        expect(parseItems([{ path: '/a/', isDir: true }, { path: '/b', isDir: 'yes', isLink: true }]))
            .toEqual([{ path: '/a', isDir: true, isLink: false }, { path: '/b', isDir: false, isLink: true }]);
        expect(() => parseItems([])).toThrow(FsError);
        expect(() => parseItems('x')).toThrow(FsError);
        expect(() => parseItems([{ path: '/' }])).toThrow(/root/);
    });

    it('parses versions', () => {
        expect(parseVersion(undefined)).toBeUndefined();
        expect(parseVersion(null)).toBeNull();
        expect(parseVersion({ size: 3, mtime: 9 })).toEqual({ size: 3, mtime: 9 });
        expect(() => parseVersion({ size: -1, mtime: 0 })).toThrow(FsError);
    });

    it('accepts binary payloads only, within the limit', () => {
        expect(parseBytes(Buffer.from('ab'), 10)).toEqual(Buffer.from('ab'));
        expect(parseBytes(new Uint8Array([1, 2]).buffer, 10)).toEqual(Buffer.from([1, 2]));
        expect(parseBytes(new Uint8Array([0, 1, 2, 3]).subarray(1, 3), 10)).toEqual(Buffer.from([1, 2]));
        expect(() => parseBytes('aGVsbG8=', 10)).toThrow(/binary/);
        expect(() => parseBytes(Buffer.alloc(11), 10)).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
    });
});

describe('respond', () => {
    it('answers with the result or a typed error, including synchronous throws', async () => {
        const reply = vi.fn();
        respond('test', reply, async () => ({ fine: true }));
        respond('test', reply, () => { throw new FsError('INVALID', 'bad path'); });
        respond('test', reply, async () => { throw new FsError('CONFLICT', 'changed', { current: null }); });
        respond('test', reply, async () => { throw new Error('boom'); });
        await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(4));
        expect(reply.mock.calls.map(([result]) => result)).toEqual(expect.arrayContaining([
            { ok: true, data: { fine: true } },
            { ok: false, error: { code: 'INVALID', message: 'bad path' } },
            { ok: false, error: { code: 'CONFLICT', message: 'changed', current: null } },
            { ok: false, error: { code: 'FAILED', message: 'boom' } },
        ]));
    });

    it('does nothing for requests without an acknowledgement', async () => {
        const work = vi.fn(async () => 1);
        respond('test', undefined, work);
        expect(work).not.toHaveBeenCalled();
    });
});
