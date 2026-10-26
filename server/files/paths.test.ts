import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../shared/files';
import {
    encodeS3CopySource,
    ftpReplyPath,
    normalizeFtpPath,
    s3Key,
    s3Prefix,
    sortEntries,
} from './paths';

// The lexical helpers and name rules are tested in shared/remotePaths.test.ts.

describe('normalizeFtpPath', () => {
    it('drops the slash before a drive letter and keeps names as they are', () => {
        expect(normalizeFtpPath('/home/user/file.txt')).toBe('/home/user/file.txt');
        expect(normalizeFtpPath('/C:/Users/admin')).toBe('C:/Users/admin');
        // Quotes and backslashes are part of names: never the path of another file.
        expect(normalizeFtpPath('/srv/a"b.txt')).toBe('/srv/a"b.txt');
        expect(normalizeFtpPath('/srv/back\\slash')).toBe('/srv/back\\slash');
    });
});

describe('ftpReplyPath', () => {
    it('reads the directories servers report, including Windows ones', () => {
        expect(ftpReplyPath('/home/ftp')).toBe('/home/ftp');
        expect(ftpReplyPath('home/ftp/')).toBe('/home/ftp');
        expect(ftpReplyPath('C:\\inetpub\\ftproot')).toBe('/C:/inetpub/ftproot');
        expect(normalizeFtpPath(ftpReplyPath('C:\\inetpub'))).toBe('C:/inetpub');
    });
});

describe('S3 keys', () => {
    it('maps paths to keys and folder prefixes', () => {
        expect(s3Key('/photos/2024/a.jpg')).toBe('photos/2024/a.jpg');
        expect(s3Key('/')).toBe('');
        expect(s3Prefix('/photos/')).toBe('photos/');
        expect(s3Prefix('/')).toBe('');
    });

    it('URL-encodes copy sources but keeps "/" separators', () => {
        expect(encodeS3CopySource('bucket', 'a b/c+d.txt')).toBe('bucket/a%20b/c%2Bd.txt');
        expect(encodeS3CopySource('bucket', 'dir/ñ.txt')).toBe('bucket/dir/%C3%B1.txt');
    });
});

describe('sortEntries', () => {
    const entry = (name: string, isDir = false): FileEntry => ({ name, isDir, isLink: false, size: 0, mtime: 0, permissions: 0 });

    it('puts folders first and orders numbers naturally', () => {
        const sorted = sortEntries([entry('file10'), entry('b', true), entry('File2'), entry('a', true), entry('file1')]);
        expect(sorted.map((item) => item.name)).toEqual(['a', 'b', 'file1', 'File2', 'file10']);
    });

    it('sorts 10,000 entries quickly', () => {
        const many = Array.from({ length: 10_000 }, (_, i) => entry(`log-${(i * 7919) % 10_000}.txt`));
        const started = performance.now();
        sortEntries(many);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(many[0].name).toBe('log-0.txt');
        expect(many[9_999].name).toBe('log-9999.txt');
    });
});
