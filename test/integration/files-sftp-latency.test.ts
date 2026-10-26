import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_WINDOW, type ListResult } from '../../shared/files';
import { downloadBytes, ok, openFileSession, uploadBytes, type FileSocket } from '../helpers/fileClient';
import { createSftpStats, serveSftpDirectory } from '../helpers/sftpDirectory';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// On a distant server every SFTP request costs a round trip: the file session
// must keep many of them in flight (perf-sftp-list-latency,
// perf-sftp-transfers-rtt-bound). Every answer here is delayed, and the test
// server counts how many requests wait for their answer at once.

vi.setConfig({ testTimeout: 30_000 });

let server: TestServer;
let harness: SshHarness;
let root: string;
let socket: FileSocket;
const stats = createSftpStats();
const local = (remote: string) => path.join(root, ...remote.split('/').filter(Boolean));

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-sftp-latency-'));
    fs.mkdirSync(local('/data/many'), { recursive: true });
    for (let i = 0; i < 1000; i++) fs.writeFileSync(local(`/data/many/f-${i}`), '');
    fs.mkdirSync(local('/data/links'));
    for (let i = 0; i < 200; i++) fs.writeFileSync(local(`/data/links/l-${i}`), 'x');
    fs.writeFileSync(local('/data/big.bin'), randomBytes(4 * 1024 * 1024));

    server = await bootTestServer();
    harness = await startSshServer({
        sftp: (sftp) => serveSftpDirectory(sftp, root, {
            home: '/data', readdirDelayMs: 20, statDelayMs: 10, readDelayMs: 5, writeDelayMs: 5, stats,
            reportAsLink: (name) => name.startsWith('l-'),
        }),
    });
    const created = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'far', ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'secret' }),
    }).then((res) => res.json() as Promise<{ data: { id: number } }>);
    socket = await openFileSession(server, created.data.id);
});

beforeEach(() => {
    stats.peak = {};
});

afterAll(async () => {
    socket?.disconnect();
    await server?.close();
    await harness?.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('SFTP on a high-latency link', () => {
    it('lists a large folder with several READDIR requests in flight', async () => {
        const listing = await ok<ListResult>(socket, 'files-list', { path: '/data/many' });
        expect(listing.entries).toHaveLength(1000);
        expect(new Set(listing.entries.map((entry) => entry.name)).size).toBe(1000);
        expect(stats.peak.READDIR).toBeGreaterThanOrEqual(4);
    });

    it('resolves the links of a folder many at a time', async () => {
        const listing = await ok<ListResult>(socket, 'files-list', { path: '/data/links' });
        expect(listing.entries).toHaveLength(200);
        expect(listing.entries.every((entry) => entry.isLink && !entry.isDir && entry.size === 1)).toBe(true);
        expect(stats.peak.STAT).toBeGreaterThan(16);
    });

    it('keeps a whole SSH window of reads in flight while downloading', async () => {
        const result = await downloadBytes(socket, '/data/big.bin');
        expect(result.data.equals(fs.readFileSync(local('/data/big.bin')))).toBe(true);
        expect(stats.peak.READ).toBeGreaterThan(32);
    });

    it('keeps a whole SSH window of writes in flight while uploading', async () => {
        const data = randomBytes(4 * 1024 * 1024);
        expect(await uploadBytes(socket, '/data/up.bin', data)).toMatchObject({ ok: true, data: { size: data.length } });
        expect(fs.readFileSync(local('/data/up.bin')).equals(data)).toBe(true);
        expect(UPLOAD_WINDOW).toBe(8);
        expect(stats.peak.WRITE).toBeGreaterThan(32);
    });
});
