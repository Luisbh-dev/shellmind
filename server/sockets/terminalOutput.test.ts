import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalOutput, Utf8Boundary } from './terminalOutput';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

function setup(options: ConstructorParameters<typeof TerminalOutput>[1] = {}) {
    const sent: Buffer[] = [];
    const output = new TerminalOutput((data) => sent.push(data), options);
    const source = { pause: vi.fn(), resume: vi.fn(), discard: vi.fn(() => 0) };
    output.attach(source);
    const text = () => sent.map((data) => data.toString('utf8'));
    return { sent, text, output, source };
}

describe('TerminalOutput', () => {
    it('sends a piece that follows a quiet moment on the next turn, not after the frame timer', () => {
        const { text, output } = setup();
        // A keystroke's echo.
        output.write('l');
        expect(text()).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(text()).toEqual(['l']);

        // Pieces of one read still go out as one message.
        vi.advanceTimersByTime(100);
        for (let i = 0; i < 100; i++) output.write(`line ${i}\r\n`);
        vi.advanceTimersByTime(1);
        expect(text()).toHaveLength(2);
        expect(text()[1].split('\r\n')).toHaveLength(101);
    });

    it('batches output that keeps streaming into one message per frame', () => {
        const { sent, output } = setup();
        // 200 ms of a flood: a piece every 2 ms.
        for (let i = 0; i < 100; i++) {
            output.write(`${i}\r\n`);
            vi.advanceTimersByTime(2);
        }
        vi.advanceTimersByTime(16);
        expect(sent.length).toBeGreaterThan(5);
        expect(sent.length).toBeLessThan(20);
        expect(Buffer.concat(sent).toString()).toBe(Array.from({ length: 100 }, (_, i) => `${i}\r\n`).join(''));

        // Right after a flush, the next piece waits for the frame.
        output.write('x');
        output.flush();
        output.write('y');
        vi.advanceTimersByTime(1);
        expect(sent.at(-1)?.toString()).toBe('x');
        vi.advanceTimersByTime(16);
        expect(sent.at(-1)?.toString()).toBe('y');
    });

    it('sends at once when a batch is full', () => {
        const { text, output } = setup({ maxBatchBytes: 10 });
        output.write('12345');
        output.write('67890ab');
        expect(text()).toEqual(['1234567890ab']);
    });

    it('flushes on demand, before state events', () => {
        const { text, output } = setup();
        output.write('bye');
        output.flush();
        expect(text()).toEqual(['bye']);
        output.flush();
        vi.advanceTimersByTime(100);
        expect(text()).toEqual(['bye']);
    });

    it('sends bytes: text as UTF-8, buffers as they are', () => {
        const { sent, output } = setup();
        output.write('ñ€');
        output.write(Buffer.from([0x41, 0x42]));
        output.flush();
        expect(sent).toEqual([Buffer.from('ñ€AB', 'utf8')]);
        // Acknowledged in bytes.
        output.ack(0);
        expect(output.pendingBytes).toBe(7);
    });

    it('does not throttle a client that never acknowledges', () => {
        const { output, source } = setup({ highWaterBytes: 10, lowWaterBytes: 5 });
        output.write('x'.repeat(100));
        output.flush();
        expect(source.pause).not.toHaveBeenCalled();
    });

    it('pauses the program while too much output is unacknowledged and resumes it once the client catches up', () => {
        const { output, source } = setup({ highWaterBytes: 100, lowWaterBytes: 20 });
        output.ack(0);

        output.write('x'.repeat(60));
        output.flush();
        expect(source.pause).not.toHaveBeenCalled();
        output.write('x'.repeat(60));
        output.flush();
        expect(source.pause).toHaveBeenCalledTimes(1);
        expect(output.isPaused).toBe(true);

        // A program attached while paused starts paused.
        const late = { pause: vi.fn(), resume: vi.fn() };
        output.attach(late);
        expect(late.pause).toHaveBeenCalledTimes(1);

        output.ack(60);
        expect(source.resume).not.toHaveBeenCalled();
        output.ack(50);
        expect(source.resume).toHaveBeenCalledTimes(1);
        expect(late.resume).toHaveBeenCalledTimes(1);
        expect(output.pendingBytes).toBe(10);
    });

    it('keeps the default watermarks low enough for Ctrl+C to come back quickly', async () => {
        const { TERMINAL_OUTPUT_DEFAULTS } = await import('./terminalOutput');
        expect(TERMINAL_OUTPUT_DEFAULTS.highWaterBytes).toBeLessThanOrEqual(128 * 1024);
        expect(TERMINAL_OUTPUT_DEFAULTS.lowWaterBytes).toBeLessThanOrEqual(32 * 1024);
    });

    it('drops the output held back for a lagging client on an interrupt', () => {
        const { sent, output, source } = setup({ highWaterBytes: 10, lowWaterBytes: 5 });
        source.discard.mockReturnValue(4096);
        output.ack(0);
        // Not paused: nothing is dropped.
        output.write('abc');
        expect(output.interrupt()).toBe(0);
        expect(source.discard).not.toHaveBeenCalled();

        output.write('x'.repeat(20));
        output.flush();
        expect(output.isPaused).toBe(true);
        output.write('stale output');
        expect(output.interrupt()).toBe('stale output'.length + 4096);
        expect(source.discard).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(100);
        expect(Buffer.concat(sent).toString()).toBe(`abc${'x'.repeat(20)}`);
    });

    it('ignores invalid acknowledgements', () => {
        const { output } = setup();
        output.write('abc');
        output.flush();
        for (const value of [-5, Number.NaN, Infinity, '3', null]) output.ack(value);
        expect(output.pendingBytes).toBe(3);
    });

    it('drops everything once disposed', () => {
        const { sent, output, source } = setup({ highWaterBytes: 1 });
        output.ack(0);
        output.write('pending');
        output.dispose();
        vi.advanceTimersByTime(100);
        output.write('more');
        output.flush();
        expect(sent).toEqual([]);
        expect(source.pause).not.toHaveBeenCalled();
    });
});

describe('Utf8Boundary', () => {
    it('never lets a chunk end inside a character', () => {
        const bytes = Buffer.from('añ€😀z', 'utf8');
        // Every way of cutting the text in two.
        for (let cut = 0; cut <= bytes.length; cut++) {
            const boundary = new Utf8Boundary();
            const first = boundary.push(bytes.subarray(0, cut));
            const second = boundary.push(bytes.subarray(cut));
            expect(first.toString('utf8')).not.toContain('�');
            expect(second.toString('utf8')).not.toContain('�');
            expect(Buffer.concat([first, second]).toString('utf8')).toBe('añ€😀z');
            expect(boundary.end()).toHaveLength(0);
        }
    });

    it('hands over a cut-off character at the end, and passes bytes that are no UTF-8', () => {
        const boundary = new Utf8Boundary();
        expect(boundary.push(Buffer.from([0x61, 0xe2, 0x82]))).toEqual(Buffer.from([0x61]));
        expect(boundary.end()).toEqual(Buffer.from([0xe2, 0x82]));
        const binary = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80]);
        expect(new Utf8Boundary().push(binary)).toEqual(binary);
    });
});
