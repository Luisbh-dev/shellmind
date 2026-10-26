import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3Fs, s3Error } from './s3Fs';

// An in-memory bucket answering the S3 commands S3Fs sends, with 1000-key
// pages like the real service and switches to make copies or deletes fail.
class FakeBucket {
    readonly objects = new Map<string, { body: Buffer; size: number; modified: Date }>();
    readonly calls: string[] = [];
    readonly deleteBatches: number[] = [];
    failCopy = new Set<string>();
    failDelete = new Set<string>();

    put(key: string, body: string | Buffer = '', size?: number) {
        const buffer = Buffer.from(body);
        this.objects.set(key, { body: buffer, size: size ?? buffer.length, modified: new Date(Date.UTC(2024, 0, 2)) });
    }

    client(): S3Client {
        return { send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => this.send(command), destroy: () => undefined } as unknown as S3Client;
    }

    private notFound() {
        return Object.assign(new Error('Not Found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    }

    private async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
        const name = command.constructor.name.replace(/Command$/, '');
        const input = command.input;
        this.calls.push(name);
        switch (name) {
            case 'ListObjectsV2': {
                const prefix = String(input.Prefix ?? '');
                const delimiter = input.Delimiter as string | undefined;
                // Like S3, the token marks the last key returned: keys deleted
                // in between do not shift the next page.
                const after = input.ContinuationToken as string | undefined;
                const pageSize = Math.min(Number(input.MaxKeys ?? 1000), 1000);
                const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
                const rows: Array<{ key?: string; prefix?: string }> = [];
                const seen = new Set<string>();
                for (const key of keys) {
                    const rest = key.slice(prefix.length);
                    const cut = delimiter ? rest.indexOf(delimiter) : -1;
                    if (cut >= 0) {
                        const common = prefix + rest.slice(0, cut + 1);
                        if (!seen.has(common)) {
                            seen.add(common);
                            rows.push({ prefix: common });
                        }
                    } else {
                        rows.push({ key });
                    }
                }
                const remaining = after === undefined ? rows : rows.filter((row) => (row.key ?? row.prefix)! > after);
                const page = remaining.slice(0, pageSize);
                const truncated = remaining.length > pageSize;
                const last = page.at(-1);
                return {
                    Contents: page.filter((row) => row.key).map((row) => {
                        const object = this.objects.get(row.key!)!;
                        return { Key: row.key, Size: object.size, LastModified: object.modified };
                    }),
                    CommonPrefixes: page.filter((row) => row.prefix).map((row) => ({ Prefix: row.prefix })),
                    KeyCount: page.length,
                    IsTruncated: truncated,
                    NextContinuationToken: truncated && last ? (last.key ?? last.prefix) : undefined,
                };
            }
            case 'HeadObject': {
                const object = this.objects.get(String(input.Key));
                if (!object) throw this.notFound();
                return { ContentLength: object.size, LastModified: object.modified };
            }
            case 'GetObject': {
                const object = this.objects.get(String(input.Key));
                if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
                return { Body: Readable.from(object.body.length ? [object.body] : []), ContentLength: object.size };
            }
            case 'PutObject':
                this.put(String(input.Key), (input.Body as Buffer | undefined) ?? '');
                return {};
            case 'DeleteObject':
                this.objects.delete(String(input.Key));
                return {};
            case 'DeleteObjects': {
                const keys = (input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((object) => object.Key);
                this.deleteBatches.push(keys.length);
                const errors = keys.filter((key) => this.failDelete.has(key)).map((Key) => ({ Key, Code: 'AccessDenied', Message: 'Object is locked' }));
                for (const key of keys) if (!this.failDelete.has(key)) this.objects.delete(key);
                return { Errors: errors.length ? errors : undefined };
            }
            case 'CopyObject': {
                const source = decodeURIComponent(String(input.CopySource)).replace(/^[^/]+\//, '');
                if (this.failCopy.has(source)) throw Object.assign(new Error('copy refused'), { name: 'InternalError' });
                const object = this.objects.get(source)!;
                this.objects.set(String(input.Key), { ...object });
                return {};
            }
            case 'CreateMultipartUpload':
                return { UploadId: 'upload-1' };
            case 'UploadPartCopy':
                return { CopyPartResult: { ETag: `etag-${String(input.PartNumber)}` } };
            case 'CompleteMultipartUpload': {
                const parts = (input.MultipartUpload as { Parts: unknown[] }).Parts;
                this.calls.push(`parts:${parts.length}`);
                return {};
            }
            default:
                throw new Error(`unexpected command ${name}`);
        }
    }
}

const setup = () => {
    const bucket = new FakeBucket();
    return { bucket, fs: new S3Fs(bucket.client(), 'bucket', true) };
};

describe('S3Fs listing', () => {
    it('follows continuation tokens past the first 1000 keys', async () => {
        const { bucket, fs } = setup();
        for (let i = 0; i < 2500; i++) bucket.put(`logs/app-${i}.log`, 'x');
        bucket.put('logs/archive/old.log', 'x');
        bucket.put('logs/empty/', '');
        const listing = await fs.list('/logs');
        expect(listing.truncated).toBe(false);
        expect(listing.entries).toHaveLength(2502);
        expect(listing.entries.slice(0, 2).map((entry) => [entry.name, entry.isDir])).toEqual([['archive', true], ['empty', true]]);
        expect(listing.entries[2]).toMatchObject({ name: 'app-0.log', isDir: false, size: 1, mtime: Date.UTC(2024, 0, 2) / 1000 });
        expect(bucket.calls.filter((call) => call === 'ListObjectsV2')).toHaveLength(3);
    });

    it('says when a listing is cut at the entry limit', async () => {
        const { bucket, fs } = setup();
        for (let i = 0; i < 50_500; i++) bucket.put(`big/${i}`, '');
        const listing = await fs.list('/big');
        expect(listing.entries).toHaveLength(50_000);
        expect(listing.truncated).toBe(true);
    });

    it('tells a missing folder from an empty one', async () => {
        const { bucket, fs } = setup();
        bucket.put('empty/');
        await expect(fs.list('/missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect((await fs.list('/empty')).entries).toEqual([]);
        expect((await fs.list('/')).entries.map((entry) => entry.name)).toEqual(['empty']);
    });
});

describe('S3Fs reads', () => {
    it('reads empty objects as empty files', async () => {
        const { bucket, fs } = setup();
        bucket.put('.keep', '');
        const read = await fs.readFile('/.keep', 1024);
        expect(read.data.length).toBe(0);
        expect(read.stat).toMatchObject({ isDir: false, size: 0 });
    });

    it('refuses objects above the limit before downloading them', async () => {
        const { bucket, fs } = setup();
        bucket.put('huge.bin', 'x', 5 * 1024 * 1024);
        await expect(fs.readFile('/huge.bin', 2 * 1024 * 1024)).rejects.toMatchObject({ code: 'TOO_LARGE' });
        expect(bucket.calls).not.toContain('GetObject');
    });

    it('stats objects, folders and missing paths', async () => {
        const { bucket, fs } = setup();
        bucket.put('a/b.txt', 'hi');
        expect(await fs.stat('/a/b.txt')).toMatchObject({ isDir: false, size: 2 });
        expect(await fs.stat('/a')).toMatchObject({ isDir: true });
        expect(await fs.stat('/nope')).toBeNull();
    });
});

describe('S3Fs deletes', () => {
    it('deletes folders page by page and reports the keys S3 refused', async () => {
        const { bucket, fs } = setup();
        for (let i = 0; i < 2500; i++) bucket.put(`data/${i}.bin`, 'x');
        bucket.failDelete = new Set(['data/7.bin', 'data/2001.bin']);
        const result = await fs.remove([{ path: '/data', isDir: true }]);
        expect(result.deleted).toBe(2498);
        expect(result.failureCount).toBe(2);
        // S3 lists keys in lexicographic order.
        expect(result.failures).toEqual([
            { path: '/data/2001.bin', message: 'AccessDenied: Object is locked' },
            { path: '/data/7.bin', message: 'AccessDenied: Object is locked' },
        ]);
        expect(Math.max(...bucket.deleteBatches)).toBeLessThanOrEqual(1000);
        expect([...bucket.objects.keys()].sort()).toEqual(['data/2001.bin', 'data/7.bin']);
    });

    it('deletes selected files in batches, not one request each', async () => {
        const { bucket, fs } = setup();
        for (let i = 0; i < 2500; i++) bucket.put(`flat/${i}.log`, 'x');
        bucket.put('flat/sub/inner.log', 'x');
        bucket.failDelete = new Set(['flat/42.log']);
        const items = Array.from({ length: 2500 }, (_, i) => ({ path: `/flat/${i}.log`, isDir: false }));
        const result = await fs.remove([...items, { path: '/flat/sub', isDir: true }]);
        expect(result).toEqual({ deleted: 2500, failures: [{ path: '/flat/42.log', message: 'AccessDenied: Object is locked' }], failureCount: 1 });
        expect(bucket.deleteBatches).toEqual([1000, 1000, 500, 1]);
        expect(bucket.calls).not.toContain('DeleteObject');
        expect([...bucket.objects.keys()]).toEqual(['flat/42.log']);
    });
});

describe('S3Fs renames', () => {
    it('moves every page of a large folder', async () => {
        const { bucket, fs } = setup();
        for (let i = 0; i < 1500; i++) bucket.put(`old/${i}.txt`, String(i));
        await fs.rename('/old', '/new', true);
        const keys = [...bucket.objects.keys()];
        expect(keys.filter((key) => key.startsWith('old/'))).toEqual([]);
        expect(keys.filter((key) => key.startsWith('new/'))).toHaveLength(1500);
    });

    it('keeps the sources whose copy failed and reports a partial move', async () => {
        const { bucket, fs } = setup();
        for (let i = 0; i < 1200; i++) bucket.put(`src/${i}`, 'x');
        bucket.failCopy = new Set(['src/1100']);
        await expect(fs.rename('/src', '/dst', true)).rejects.toMatchObject({
            code: 'PARTIAL',
            failureCount: 1,
            failures: [{ path: '/src/1100', message: expect.stringContaining('copy refused') }],
        });
        expect([...bucket.objects.keys()].filter((key) => key.startsWith('src/'))).toEqual(['src/1100']);
        expect([...bucket.objects.keys()].filter((key) => key.startsWith('dst/'))).toHaveLength(1199);
    });

    it('refuses to replace or to move a folder into itself', async () => {
        const { bucket, fs } = setup();
        bucket.put('a/x', '1');
        bucket.put('b/y', '2');
        await expect(fs.rename('/a', '/b', true)).rejects.toMatchObject({ code: 'EXISTS' });
        await expect(fs.rename('/a', '/a/inner', true)).rejects.toMatchObject({ code: 'INVALID' });
        await expect(fs.rename('/a/x', '/b/y', false)).rejects.toMatchObject({ code: 'EXISTS' });
    });

    it('copies objects over 5 GiB in parts', async () => {
        const { bucket, fs } = setup();
        bucket.put('video.raw', 'x', 6 * 1024 ** 3);
        await fs.rename('/video.raw', '/archive.raw', false);
        expect(bucket.calls).toContain('CreateMultipartUpload');
        expect(bucket.calls.filter((call) => call === 'UploadPartCopy')).toHaveLength(12);
        expect(bucket.calls).toContain('parts:12');
        expect(bucket.calls).not.toContain('CopyObject');
    });
});

describe('S3Fs counting', () => {
    it('counts objects and folder markers under folders', async () => {
        const { bucket, fs } = setup();
        bucket.put('t/a.txt', '12');
        bucket.put('t/sub/', '');
        bucket.put('t/sub/b.txt', '345');
        bucket.put('c.txt', '6');
        expect(await fs.count([{ path: '/t', isDir: true }, { path: '/c.txt', isDir: false }], { maxEntries: 100, deadline: Date.now() + 5000 }))
            .toEqual({ files: 3, dirs: 2, bytes: 6, truncated: false });
    });
});

describe('s3Error', () => {
    it('maps service errors to file error codes', () => {
        expect(s3Error(Object.assign(new Error('x'), { name: 'NoSuchKey' }), '/a').code).toBe('NOT_FOUND');
        expect(s3Error(Object.assign(new Error('x'), { name: 'AccessDenied' }), '/a').code).toBe('PERMISSION_DENIED');
        expect(s3Error(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 403 } }), '/a').code).toBe('PERMISSION_DENIED');
        expect(s3Error(Object.assign(new Error('x'), { name: 'NoSuchBucket' }), '/a').message).toMatch(/bucket/);
        expect(s3Error(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), '/a').code).toBe('NOT_CONNECTED');
        expect(s3Error(new Error('weird'), '/a')).toMatchObject({ code: 'FAILED', message: '/a: weird' });
    });
});
