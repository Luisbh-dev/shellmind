import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isReadingInput, ShellReadiness } from './shellReady';

describe('isReadingInput', () => {
    it('sees shell and tool prompts, and line editors that turned bracketed paste on', () => {
        for (const line of ['demo-server:~$ ', 'root@web-1:~# ', 'PS C:\\Users\\admin> ', 'C:\\Users\\admin>', '/ # ', 'mysql> ', 'ftp> ', '❯ $ ']) {
            expect(isReadingInput({ cursorLine: line, bracketedPaste: false }), line).toBe(true);
        }
        expect(isReadingInput({ cursorLine: '❯ ', bracketedPaste: true })).toBe(true);
    });

    it('does not take a connecting notice, a banner line or an empty line for a prompt', () => {
        for (const line of ['', 'Connected to 10.0.0.5:22', 'Last login: Fri Oct 24 09:12:01 2026 from 10.0.0.1', 'Welcome to Ubuntu 24.04 LTS']) {
            expect(isReadingInput({ cursorLine: line, bracketedPaste: false }), line).toBe(false);
        }
    });
});

describe('ShellReadiness', () => {
    let reading: boolean;
    const onReady = vi.fn();
    const timing = { quietMs: 1000, maxMs: 5000 };
    const make = () => new ShellReadiness(() => reading, onReady, timing);

    beforeEach(() => {
        vi.useFakeTimers();
        reading = false;
        onReady.mockClear();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('is ready at once when the prompt already shows', () => {
        reading = true;
        make().start();
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('becomes ready with the first output that shows a prompt, not with the banner before it', () => {
        const readiness = make();
        readiness.start();
        readiness.output();
        vi.advanceTimersByTime(500);
        expect(onReady).not.toHaveBeenCalled();
        reading = true;
        readiness.output();
        expect(onReady).toHaveBeenCalledTimes(1);
        // Later output changes nothing.
        readiness.output();
        vi.advanceTimersByTime(10_000);
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('falls back to the output going quiet, each output starting the wait again', () => {
        const readiness = make();
        readiness.start();
        readiness.output();
        vi.advanceTimersByTime(900);
        readiness.output();
        vi.advanceTimersByTime(900);
        expect(onReady).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('is ready after maxMs at the latest: no output at all, or output that never stops', () => {
        make().start();
        vi.advanceTimersByTime(4999);
        expect(onReady).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onReady).toHaveBeenCalledTimes(1);

        const flooding = make();
        flooding.start();
        for (let elapsed = 0; elapsed < 5000; elapsed += 200) {
            flooding.output();
            vi.advanceTimersByTime(200);
        }
        expect(onReady).toHaveBeenCalledTimes(2);
    });

    it('ignores output outside a session, and stop() cancels a pending wait', () => {
        const readiness = make();
        readiness.output();
        vi.advanceTimersByTime(10_000);
        expect(onReady).not.toHaveBeenCalled();

        readiness.start();
        readiness.output();
        readiness.stop();
        vi.advanceTimersByTime(10_000);
        expect(onReady).not.toHaveBeenCalled();

        // A new session waits again from the start.
        readiness.start();
        reading = true;
        readiness.output();
        expect(onReady).toHaveBeenCalledTimes(1);
    });
});
