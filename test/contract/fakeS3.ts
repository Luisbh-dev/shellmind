import { createHash, randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// An in-process S3-compatible endpoint (path-style, like MinIO) for the
// requests the backend's S3 file manager sends through the real AWS SDK:
// listing, HEAD/GET, PutObject, multipart uploads, CopyObject and
// DeleteObjects. Like the S3-compatible services that predate the SDK's CRC32
// checksums, it refuses a DeleteObjects without Content-MD5.

export type S3Call = { method: string; key: string; action: string; headers: IncomingMessage['headers'] };

export type FakeS3 = {
    endpoint: string;
    bucket: string;
    objects: Map<string, Buffer>;
    // Multipart uploads still open.
    uploads: Map<string, { key: string; parts: Map<number, Buffer> }>;
    calls: S3Call[];
    close: () => Promise<void>;
};

const xml = (res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
};
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const etag = (data: Buffer) => `"${createHash('md5').update(data).digest('hex')}"`;

// aws-chunked bodies (streaming uploads): "<hex size>[;ext]\r\n<data>\r\n"...
// until a zero-size chunk, then trailers.
function decodeAwsChunked(raw: Buffer): Buffer {
    const parts: Buffer[] = [];
    let at = 0;
    for (;;) {
        const lineEnd = raw.indexOf('\r\n', at);
        if (lineEnd < 0) break;
        const size = parseInt(raw.subarray(at, lineEnd).toString('latin1').split(';')[0]!, 16);
        if (!size) break;
        parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
        at = lineEnd + 2 + size + 2;
    }
    return Buffer.concat(parts);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const chunked = /aws-chunked/i.test(String(req.headers['content-encoding'] ?? '')) || String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-');
    return chunked ? decodeAwsChunked(raw) : raw;
}

export async function startFakeS3(bucket = 'backups'): Promise<FakeS3> {
    const objects = new Map<string, Buffer>();
    const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
    const calls: S3Call[] = [];

    const handle = async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://s3.local');
        const [, bucketName, ...rest] = url.pathname.split('/');
        const key = decodeURIComponent(rest.join('/'));
        const query = url.searchParams;
        const body = await readBody(req);
        const action = ['uploads', 'uploadId', 'partNumber', 'delete', 'list-type'].filter((name) => query.has(name)).join('+') || (req.headers['x-amz-copy-source'] ? 'copy' : '');
        calls.push({ method: req.method ?? '', key, action, headers: req.headers });

        if (bucketName !== bucket) return xml(res, 404, '<Error><Code>NoSuchBucket</Code></Error>');

        if (req.method === 'GET' && !key) {
            const prefix = query.get('prefix') ?? '';
            const delimiter = query.get('delimiter');
            const keys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
            const contents: string[] = [];
            const common = new Set<string>();
            for (const name of keys) {
                const restOfKey = name.slice(prefix.length);
                const cut = delimiter ? restOfKey.indexOf(delimiter) : -1;
                if (cut >= 0) common.add(prefix + restOfKey.slice(0, cut + 1));
                else contents.push(`<Contents><Key>${escape(name)}</Key><Size>${objects.get(name)!.length}</Size><LastModified>2026-01-02T03:04:05.000Z</LastModified><ETag>${etag(objects.get(name)!)}</ETag></Contents>`);
            }
            const prefixes = [...common].map((name) => `<CommonPrefixes><Prefix>${escape(name)}</Prefix></CommonPrefixes>`);
            return xml(res, 200, `<ListBucketResult><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${contents.length + prefixes.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents.join('')}${prefixes.join('')}</ListBucketResult>`);
        }

        if (req.method === 'POST' && query.has('delete')) {
            if (!req.headers['content-md5']) {
                return xml(res, 400, '<Error><Code>MissingContentMD5</Code><Message>Missing required header for this request: Content-Md5</Message></Error>');
            }
            const deleted = [...body.toString('utf8').matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) => match[1]!);
            for (const name of deleted) objects.delete(name);
            return xml(res, 200, `<DeleteResult>${deleted.map((name) => `<Deleted><Key>${escape(name)}</Key></Deleted>`).join('')}</DeleteResult>`);
        }

        if (req.method === 'POST' && query.has('uploads')) {
            const uploadId = randomBytes(8).toString('hex');
            uploads.set(uploadId, { key, parts: new Map() });
            return xml(res, 200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
        }

        const uploadId = query.get('uploadId');
        if (uploadId) {
            const upload = uploads.get(uploadId);
            if (!upload) return xml(res, 404, '<Error><Code>NoSuchUpload</Code></Error>');
            if (req.method === 'PUT') {
                upload.parts.set(Number(query.get('partNumber')), body);
                res.writeHead(200, { etag: etag(body) });
                return res.end();
            }
            if (req.method === 'POST') {
                const numbers = [...body.toString('utf8').matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((match) => Number(match[1]));
                objects.set(upload.key, Buffer.concat(numbers.map((number) => upload.parts.get(number) ?? Buffer.alloc(0))));
                uploads.delete(uploadId);
                return xml(res, 200, `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escape(upload.key)}</Key><ETag>${etag(objects.get(upload.key)!)}</ETag></CompleteMultipartUploadResult>`);
            }
            if (req.method === 'DELETE') {
                uploads.delete(uploadId);
                res.writeHead(204);
                return res.end();
            }
        }

        const object = objects.get(key);
        if (req.method === 'HEAD') {
            if (!object) {
                res.writeHead(404);
                return res.end();
            }
            res.writeHead(200, { 'content-length': object.length, etag: etag(object), 'last-modified': 'Fri, 02 Jan 2026 03:04:05 GMT' });
            return res.end();
        }
        if (req.method === 'GET') {
            if (!object) return xml(res, 404, `<Error><Code>NoSuchKey</Code><Key>${escape(key)}</Key></Error>`);
            res.writeHead(200, { 'content-length': object.length, etag: etag(object), 'last-modified': 'Fri, 02 Jan 2026 03:04:05 GMT' });
            return res.end(object);
        }
        if (req.method === 'PUT') {
            const source = req.headers['x-amz-copy-source'];
            if (source) {
                const from = decodeURIComponent(String(source)).replace(/^\/?[^/]+\//, '');
                const copied = objects.get(from);
                if (!copied) return xml(res, 404, '<Error><Code>NoSuchKey</Code></Error>');
                objects.set(key, copied);
                return xml(res, 200, `<CopyObjectResult><ETag>${etag(copied)}</ETag><LastModified>2026-01-02T03:04:05.000Z</LastModified></CopyObjectResult>`);
            }
            objects.set(key, body);
            res.writeHead(200, { etag: etag(body) });
            return res.end();
        }
        if (req.method === 'DELETE') {
            objects.delete(key);
            res.writeHead(204);
            return res.end();
        }
        return xml(res, 405, '<Error><Code>MethodNotAllowed</Code></Error>');
    };

    const server = http.createServer((req, res) => {
        handle(req, res).catch(() => {
            if (!res.headersSent) res.writeHead(500);
            res.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        endpoint: `http://127.0.0.1:${port}`,
        bucket,
        objects,
        uploads,
        calls,
        close: () => new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        }),
    };
}
