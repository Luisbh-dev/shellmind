import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { resetTerminalIssues, useTerminalIssues } from './terminalIssues';

// The drop-in the app shell uses between the terminal and the chat.

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    resetTerminalIssues(1);
    resetTerminalIssues(2);
    vi.useRealTimers();
});

describe('useTerminalIssues', () => {
    it('collects the issues of the active server without a render per chunk', () => {
        let renders = 0;
        const { result } = renderHook(({ id }) => {
            renders += 1;
            return useTerminalIssues(id);
        }, { initialProps: { id: 1 as number | undefined } });
        const { handleTerminalOutput } = result.current;

        for (let i = 0; i < 100; i++) act(() => handleTerminalOutput(`line ${i}\r\n`));
        act(() => handleTerminalOutput('Error: disk full\r\n'));
        expect(renders).toBe(1);

        act(() => vi.advanceTimersByTime(250));
        expect(renders).toBe(2);
        expect(result.current.terminalIssues.map((issue) => issue.message)).toEqual(['Error: disk full']);
        // Stable callbacks: memoized children are not re-rendered by them.
        expect(result.current.handleTerminalOutput).toBe(handleTerminalOutput);

        act(() => result.current.dismissTerminalIssue(result.current.terminalIssues[0].id));
        expect(result.current.terminalIssues).toEqual([]);
    });

    it('starts clean for another server and forgets the one it left', () => {
        const { result, rerender } = renderHook(({ id }) => useTerminalIssues(id), { initialProps: { id: 1 as number | undefined } });
        act(() => result.current.handleTerminalOutput('Error: on one\n'));
        act(() => vi.advanceTimersByTime(250));
        expect(result.current.terminalIssues).toHaveLength(1);

        // Output still waiting for classification is dropped with the server.
        act(() => result.current.handleTerminalOutput('Error: late\n'));
        rerender({ id: 2 });
        act(() => vi.advanceTimersByTime(250));
        expect(result.current.terminalIssues).toEqual([]);

        rerender({ id: 1 });
        expect(result.current.terminalIssues).toEqual([]);

        rerender({ id: undefined });
        act(() => result.current.handleTerminalOutput('Error: ignored\n'));
        act(() => vi.advanceTimersByTime(250));
        act(() => result.current.clearTerminalIssues());
        expect(result.current.terminalIssues).toEqual([]);
    });
});
