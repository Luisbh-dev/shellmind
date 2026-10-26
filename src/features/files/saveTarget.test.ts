import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemorySink, tooLargeForMemory } from './saveTarget';

const bytes = (...values: number[]) => new Uint8Array(values);

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('MemorySink', () => {
    it('collects the chunks in order into a Blob', async () => {
        const sink = new MemorySink('a.bin');
        const frame = bytes(9, 1, 2, 9);
        await sink.write(frame.subarray(1, 3));
        await sink.write(bytes(3));
        frame.fill(0);
        await sink.close();
        // A view into a larger buffer was copied, not kept.
        expect([...new Uint8Array(await sink.blob().arrayBuffer())]).toEqual([1, 2, 3]);
    });

    it('refuses to grow past its limit', async () => {
        const sink = new MemorySink('dump.sql', 4);
        await sink.write(bytes(1, 2, 3));
        await expect(sink.write(bytes(4, 5))).rejects.toMatchObject({ code: 'TOO_LARGE', message: expect.stringContaining('dump.sql is 5 B') });
        await sink.abort();
        expect(sink.blob().size).toBe(0);
    });
});

describe('tooLargeForMemory', () => {
    it('suggests another browser where the browser lacks the save picker', () => {
        vi.stubGlobal('isSecureContext', true);
        const { message } = tooLargeForMemory('disk.img', 2 * 1024 ** 3);
        expect(message).toContain('Chromium-based browsers (Chrome, Edge) save large files straight to disk');
        expect(message).not.toContain('HTTPS');
    });

    // Over plain HTTP even Chrome has no save picker: changing the browser
    // would not help, serving the app over HTTPS would.
    it('points at HTTPS when the page is not a secure context', () => {
        vi.stubGlobal('isSecureContext', false);
        const { message } = tooLargeForMemory('disk.img', 2 * 1024 ** 3);
        expect(message).toMatch(/^disk\.img is 2 GB: too large to download here\. This page is not served over HTTPS/);
        expect(message).toContain('open ShellMind over HTTPS (or on localhost)');
    });
});
