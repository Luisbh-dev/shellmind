import { createHash } from 'node:crypto';
import { DeleteObjectsCommand, PutObjectCommand, UploadPartCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import type { S3Target } from '../connections/target';
import { createS3Fs, parseFtpSecurity, s3Endpoint } from './connect';

const target = (overrides: Partial<S3Target> = {}): S3Target => ({
    kind: 's3', serverId: 1, name: 'bucket', provider: 'aws', bucket: 'b', region: null, endpoint: null, accessKey: 'AK', secretKey: 'SK', ...overrides,
});

describe('FTPS setting', () => {
    it('maps the ftp_secure column to basic-ftp security', () => {
        expect(parseFtpSecurity(1)).toBe(true);
        expect(parseFtpSecurity('explicit')).toBe(true);
        expect(parseFtpSecurity(true)).toBe(true);
        expect(parseFtpSecurity(2)).toBe('implicit');
        expect(parseFtpSecurity('implicit')).toBe('implicit');
        for (const off of [0, null, undefined, '', 'no']) expect(parseFtpSecurity(off)).toBe(false);
    });
});

describe('S3 endpoints', () => {
    it('uses custom endpoints only for "other" providers, https by default', () => {
        expect(s3Endpoint(target())).toBeNull();
        expect(s3Endpoint(target({ provider: 'other', endpoint: 'minio.local:9000' }))).toBe('https://minio.local:9000');
        expect(s3Endpoint(target({ provider: 'other', endpoint: ' http://10.0.0.5:9000 ' }))).toBe('http://10.0.0.5:9000');
    });

    it('reports http endpoints as insecure', () => {
        expect(createS3Fs(target()).transport).toBe('https');
        expect(createS3Fs(target({ provider: 'other', endpoint: 'https://s3.example.com' })).transport).toBe('https');
        expect(createS3Fs(target({ provider: 'other', endpoint: 'HTTP://10.0.0.5:9000' })).transport).toBe('http');
    });
});

type SentRequest = { headers: Record<string, string>; body: unknown };

// The request a command would send (signed), without sending it.
async function sentRequest(client: S3Client, send: (client: S3Client) => Promise<unknown>): Promise<SentRequest> {
    let request: SentRequest = { headers: {}, body: '' };
    client.middlewareStack.add(() => async (args) => {
        request = args.request as SentRequest;
        throw new Error('captured');
    }, { step: 'finalizeRequest', priority: 'low', name: 'captureRequest' });
    await expect(send(client)).rejects.toThrow('captured');
    return request;
}

const checksumHeaders = (headers: Record<string, string>) => Object.keys(headers).filter((name) => /^x-amz-(sdk-)?checksum/i.test(name));

describe('DeleteObjects', () => {
    const deleteRequest = async (client: S3Client) => {
        const request = await sentRequest(client, (s3) => s3.send(new DeleteObjectsCommand({ Bucket: 'b', Delete: { Objects: [{ Key: 'a.txt' }], Quiet: true } })));
        return { headers: request.headers, body: String(request.body) };
    };

    it('carries the Content-MD5 that S3-compatible services from before the CRC32 default require', async () => {
        const { headers, body } = await deleteRequest(createS3Fs(target({ provider: 'other', endpoint: 'http://127.0.0.1:9' })).client);
        expect(body).toContain('<Key>a.txt</Key>');
        expect(headers['content-md5']).toBe(createHash('md5').update(body).digest('base64'));
        expect(headers['x-amz-checksum-crc32']).toBeDefined();
    });

    it('is left to the SDK on AWS', async () => {
        const { headers } = await deleteRequest(createS3Fs(target()).client);
        expect(headers['content-md5']).toBeUndefined();
        expect(headers['x-amz-checksum-crc32']).toBeDefined();
    });
});

// BC-15: S3-compatible services that predate the SDK's default CRC32 checksums
// refuse uploads that carry them.
describe('upload checksums', () => {
    const custom = () => createS3Fs(target({ provider: 'other', endpoint: 'http://127.0.0.1:9' })).client;

    it('are sent to custom endpoints only where the API requires them', async () => {
        const client = custom();
        expect(await client.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
        expect(await client.config.responseChecksumValidation()).toBe('WHEN_REQUIRED');
        const put = await sentRequest(client, (s3) => s3.send(new PutObjectCommand({ Bucket: 'b', Key: 'a.txt', Body: Buffer.from('data') })));
        expect(checksumHeaders(put.headers)).toEqual([]);
        const part = await sentRequest(custom(), (s3) => s3.send(new UploadPartCommand({ Bucket: 'b', Key: 'a.txt', UploadId: 'u', PartNumber: 1, Body: Buffer.from('data') })));
        expect(checksumHeaders(part.headers)).toEqual([]);
    });

    it('keep the SDK defaults on AWS', async () => {
        const client = createS3Fs(target()).client;
        expect(await client.config.requestChecksumCalculation()).toBe('WHEN_SUPPORTED');
        const put = await sentRequest(client, (s3) => s3.send(new PutObjectCommand({ Bucket: 'b', Key: 'a.txt', Body: Buffer.from('data') })));
        expect(checksumHeaders(put.headers)).not.toEqual([]);
    });
});
