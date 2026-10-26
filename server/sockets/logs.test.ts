import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBatcher, MAX_PENDING_CHARS, PAUSE_PENDING_CHARS, RESUME_PENDING_CHARS } from './logs';

type Sent = { data: string; dropped?: number; done: () => void };

const KB = 1024;

describe('log output batching', () => {
    let sent: Sent[];
    beforeEach(() => {
        vi.useFakeTimers();
        sent = [];
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const batcher = () => createBatcher((chunk, done) => sent.push({ ...chunk, done }));
    const fakeFlow = () => {
        const calls: string[] = [];
        return { calls, pause: () => calls.push('pause'), resume: () => calls.push('resume') };
    };

    it('coalesces output for 100 ms', () => {
        const stream = batcher();
        stream.push('a\n');
        stream.push('b\n');
        expect(sent).toEqual([]);
        vi.advanceTimersByTime(100);
        expect(sent.map((chunk) => chunk.data)).toEqual(['a\nb\n']);
    });

    it('sends 64 KiB batches, at most two unacknowledged, in order across chunks', () => {
        const stream = batcher();
        stream.push('x'.repeat(40 * KB));
        stream.push('y'.repeat(60 * KB));
        stream.flush();
        expect(sent.map((chunk) => chunk.data.length)).toEqual([64 * KB, 36 * KB]);
        expect(sent[0].data).toBe('x'.repeat(40 * KB) + 'y'.repeat(24 * KB));

        stream.push('z'.repeat(10));
        vi.advanceTimersByTime(1000);
        expect(sent).toHaveLength(2);
        sent[0].done();
        sent[0].done();
        vi.advanceTimersByTime(100);
        expect(sent.map((chunk) => chunk.data)).toHaveLength(3);
        expect(sent[2].data).toBe('z'.repeat(10));
    });

    // perf-log-stream-no-backpressure: the remote command was never paused, so
    // a busy log was read at full speed and thrown away.
    it('pauses the source while the client lags behind and resumes it once it caught up', () => {
        const stream = batcher();
        const flow = fakeFlow();
        stream.attach(flow);
        stream.push('a'.repeat(64 * KB));
        stream.flush();
        stream.push('b'.repeat(64 * KB));
        stream.flush();
        // Two batches out, unacknowledged: what follows waits.
        for (let i = 0; i < 8; i += 1) stream.push('c'.repeat(32 * KB));
        expect(flow.calls).toEqual(['pause']);
        expect(PAUSE_PENDING_CHARS).toBe(256 * KB);

        // Each acknowledgement sends the next batch at once while a backlog is left.
        sent[0].done();
        expect(sent).toHaveLength(3);
        sent[1].done();
        sent[2].done();
        expect(sent).toHaveLength(5);
        // 64 KiB left: back at the resume level.
        expect(flow.calls).toEqual(['pause', 'resume']);
        expect(RESUME_PENDING_CHARS).toBe(64 * KB);
    });

    it('applies a pause that happened before the source was attached', () => {
        const stream = batcher();
        stream.push('x'.repeat(300 * KB));
        stream.flush();
        const flow = fakeFlow();
        stream.attach(flow);
        expect(flow.calls).toEqual(['pause']);
    });

    it('drops the oldest whole chunks beyond the cap and counts them', () => {
        const stream = batcher();
        stream.push('first');
        stream.flush();
        stream.push('second');
        stream.flush();
        // A resumed channel handing over its buffered window at once.
        for (let i = 0; i < 40; i += 1) stream.push(String(i % 10).repeat(32 * KB));
        sent[0].done();
        sent[1].done();
        vi.advanceTimersByTime(100);
        expect(MAX_PENDING_CHARS).toBe(1024 * KB);
        // 40 x 32 KiB arrived, the newest 1 MiB (32 chunks) was kept.
        expect(sent[2].dropped).toBe(8 * 32 * KB);
        expect(sent[2].data).toBe('8'.repeat(32 * KB) + '9'.repeat(32 * KB));
    });

    it('keeps the end of a single chunk larger than the cap', () => {
        const stream = batcher();
        stream.push('a'.repeat(100) + 'b'.repeat(MAX_PENDING_CHARS));
        stream.flush();
        expect(sent[0]).toMatchObject({ dropped: 100, data: 'b'.repeat(64 * KB) });
    });

    it('sends everything left when the stream ends, acknowledged or not', () => {
        const stream = batcher();
        stream.push('x'.repeat(300 * KB));
        stream.flushAll();
        expect(sent.map((chunk) => chunk.data.length).reduce((sum, length) => sum + length, 0)).toBe(300 * KB);
    });

    it('sends nothing after dispose, and lets a paused source run again', () => {
        const stream = batcher();
        const flow = fakeFlow();
        stream.attach(flow);
        stream.push('x'.repeat(300 * KB));
        expect(flow.calls).toEqual(['pause']);
        stream.dispose();
        expect(flow.calls).toEqual(['pause', 'resume']);
        stream.push('late');
        vi.advanceTimersByTime(500);
        stream.flush();
        stream.flushAll();
        expect(sent).toEqual([]);
    });

    // A lost connection released the channel through dispose, which also threw
    // away what the client had not received yet.
    it('keeps what is pending after release, without pausing again, for flushAll', () => {
        const stream = batcher();
        const flow = fakeFlow();
        stream.attach(flow);
        stream.push('x'.repeat(300 * KB));
        expect(flow.calls).toEqual(['pause']);
        stream.release();
        expect(flow.calls).toEqual(['pause', 'resume']);
        // The channel hands over what it buffered while paused.
        stream.push('y'.repeat(300 * KB));
        expect(flow.calls).toEqual(['pause', 'resume']);
        stream.flushAll();
        expect(sent.map((chunk) => chunk.data).join('')).toBe('x'.repeat(300 * KB) + 'y'.repeat(300 * KB));
    });

    it('does not copy the whole backlog on every push past the cap', () => {
        const stream = batcher();
        stream.push('x');
        stream.flush();
        stream.push('y');
        stream.flush();
        // 64 MiB in 32 KiB chunks with nothing acknowledged: re-slicing a
        // 512 KiB string per push took over half a second here.
        const chunk = 'z'.repeat(32 * KB);
        const started = performance.now();
        for (let i = 0; i < 2048; i += 1) stream.push(chunk);
        expect(performance.now() - started).toBeLessThan(250);
    });
});
