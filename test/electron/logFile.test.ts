import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactLogText, RotatingLogFile } from '../../electron/logFile';

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-log-'));
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('RotatingLogFile', () => {
    it('appends to an existing file', () => {
        const file = path.join(dir, 'server.log');
        fs.writeFileSync(file, 'old\n');
        const log = new RotatingLogFile(file, 1024);
        log.write('new\n');
        log.close();
        expect(fs.readFileSync(file, 'utf8')).toBe('old\nnew\n');
    });

    it('rotates to <file>.1 once the size limit would be exceeded, keeping one backup', () => {
        const file = path.join(dir, 'server.log');
        const log = new RotatingLogFile(file, 10);
        log.write('aaaaaaaa\n');
        log.write('bbbbbbbb\n');
        log.write('cccccccc\n');
        log.close();
        expect(fs.readFileSync(file, 'utf8')).toBe('cccccccc\n');
        expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('bbbbbbbb\n');
        expect(fs.readdirSync(dir).sort()).toEqual(['server.log', 'server.log.1']);
    });

    it('rotates an oversized file left by a previous run on the first write', () => {
        const file = path.join(dir, 'server.log');
        fs.writeFileSync(file, 'x'.repeat(50));
        const log = new RotatingLogFile(file, 20);
        log.write('fresh\n');
        log.close();
        expect(fs.readFileSync(file, 'utf8')).toBe('fresh\n');
        expect(fs.statSync(`${file}.1`).size).toBe(50);
    });

    it.skipIf(process.platform === 'win32')('creates the file readable by the owner only', () => {
        const file = path.join(dir, 'server.log');
        const log = new RotatingLogFile(file);
        log.write('x\n');
        log.close();
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === 'win32')('tightens world-readable logs left by older versions', () => {
        const file = path.join(dir, 'server.log');
        fs.writeFileSync(file, 'old\n', { mode: 0o644 });
        fs.writeFileSync(`${file}.1`, 'older\n', { mode: 0o644 });
        const log = new RotatingLogFile(file);
        log.write('x\n');
        log.close();
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.statSync(`${file}.1`).mode & 0o777).toBe(0o600);
    });

    it('restricts an existing log and its backup on open, whatever their mode', () => {
        const file = path.join(dir, 'server.log');
        fs.writeFileSync(file, 'old\n');
        const fchmod = vi.spyOn(fs, 'fchmodSync');
        const chmod = vi.spyOn(fs, 'chmodSync');
        const log = new RotatingLogFile(file);
        log.write('x\n');
        log.close();
        expect(fchmod).toHaveBeenCalledWith(expect.any(Number), 0o600);
        expect(chmod).toHaveBeenCalledWith(`${file}.1`, 0o600);
        expect(fs.readFileSync(file, 'utf8')).toBe('old\nx\n');
    });

    it('never throws when the file cannot be written', () => {
        const log = new RotatingLogFile(path.join(dir, 'missing', 'server.log'));
        const errors: unknown[] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => { errors.push(args); };
        try {
            expect(() => log.write('x\n')).not.toThrow();
        } finally {
            console.error = original;
        }
        expect(errors).toHaveLength(1);
    });
});

describe('redactLogText', () => {
    it('masks the session token of the UI URL that Electron repeats in its errors', () => {
        const message = "ERR_FILE_NOT_FOUND (-6) loading 'file:///C:/app/dist/index.html?api=http%3A%2F%2F127.0.0.1%3A49152&token=s3cr3t-T0k_en'";
        expect(redactLogText(message)).toBe(
            "ERR_FILE_NOT_FOUND (-6) loading 'file:///C:/app/dist/index.html?api=http%3A%2F%2F127.0.0.1%3A49152&token=[redacted]'"
        );
        expect(redactLogText('http://localhost:5173/?token=abc#x')).toBe('http://localhost:5173/?token=[redacted]#x');
    });

    it('masks bearer tokens and leaves other text alone', () => {
        expect(redactLogText('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer [redacted]');
        expect(redactLogText('Backend ready on 127.0.0.1:49152')).toBe('Backend ready on 127.0.0.1:49152');
        expect(redactLogText('the tokens=3 setting')).toBe('the tokens=3 setting');
    });
});
