import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { terminalOverlayColors } from '@/features/appearance/terminalThemes';
import { ErrorMarkers } from './errorMarkers';

// The inline error markers against a fake xterm: which rows get one, and
// that each "!" stays on (and reports) its own row.

type FakeMarker = { line: number; isDisposed: boolean; dispose: () => void; onDispose: (listener: () => void) => { dispose: () => void } };
type FakeDecoration = { marker: FakeMarker; backgroundColor?: string; element: HTMLElement | null; disposed: boolean; render: () => HTMLElement };

function fakeTerminal(rows: string[]) {
    const decorations: FakeDecoration[] = [];
    const eraseHandlers: Array<(params: number[]) => boolean> = [];
    const cursorRow = () => rows.length - 1;
    const marker = (line: number): FakeMarker => {
        const listeners: Array<() => void> = [];
        const created: FakeMarker = {
            line,
            isDisposed: false,
            dispose: () => {
                if (created.isDisposed) return;
                created.isDisposed = true;
                listeners.forEach((listener) => listener());
            },
            onDispose: (listener) => {
                listeners.push(listener);
                return { dispose: () => undefined };
            }
        };
        return created;
    };
    const term = {
        cols: 80,
        parser: {
            registerCsiHandler: (id: { final: string }, handler: (params: number[]) => boolean) => {
                if (id.final === 'J') eraseHandlers.push(handler);
                return { dispose: () => eraseHandlers.splice(eraseHandlers.indexOf(handler), 1) };
            }
        },
        buffer: {
            active: {
                type: 'normal',
                baseY: 0,
                get cursorY() {
                    return cursorRow();
                },
                getLine: (row: number) => (row < rows.length ? { translateToString: () => rows[row], isWrapped: false } : undefined)
            }
        },
        registerMarker: (offset: number) => marker(cursorRow() + offset),
        registerDecoration: (options: { marker: FakeMarker; backgroundColor?: string }) => {
            const listeners: Array<(element: HTMLElement) => void> = [];
            const entry: FakeDecoration = {
                marker: options.marker,
                backgroundColor: options.backgroundColor,
                element: null,
                disposed: false,
                // What xterm does: one element per decoration, positioned by
                // its stylesheet (absolute) and an inline `top`.
                render: () => {
                    const element = document.createElement('div');
                    element.className = 'xterm-decoration';
                    element.style.top = `${options.marker.line * 20}px`;
                    listeners.forEach((listener) => listener(element));
                    entry.element = element;
                    return element;
                }
            };
            decorations.push(entry);
            return {
                onRender: (listener: (element: HTMLElement) => void) => listeners.push(listener),
                dispose: () => {
                    entry.disposed = true;
                }
            };
        }
    };
    // What `clear` prints: ESC [ H ESC [ 2 J ESC [ 3 J. xterm handles it as well.
    const erase = (replacement: string[]) => {
        for (const mode of [2, 3]) expect(eraseHandlers.every((handler) => handler([mode]) === false)).toBe(true);
        rows.splice(0, rows.length, ...replacement);
    };
    return { term: term as unknown as Terminal, decorations, erase };
}

const LOG = ['ERROR: database down', 'Error: x is broken', 'FATAL: disk'];

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('ErrorMarkers', () => {
    it('keeps each "!" on its own row and reports that row (terminal-error-action-wrong-target)', () => {
        const rows = ['luis@web:~$ ./deploy.sh', ...LOG, 'luis@web:~$ '];
        const { term, decorations } = fakeTerminal(rows);
        const onFix = vi.fn();
        const markers = new ErrorMarkers(term, { label: () => 'Ask the AI', onFix });
        markers.schedule();
        vi.advanceTimersByTime(200);

        expect(decorations.map((decoration) => decoration.marker.line)).toEqual([1, 2, 3]);
        decorations.forEach((decoration, index) => {
            const element = decoration.render();
            // xterm's stylesheet places the element; an inline position would
            // stack consecutive markers below each other.
            expect(element.style.position).toBe('');
            expect(element.style.top).toBe(`${(index + 1) * 20}px`);
            const button = element.querySelector('button');
            expect(button).toHaveAttribute('aria-label', 'Ask the AI');
            button?.click();
            expect(onFix).toHaveBeenLastCalledWith(LOG[index]);
        });
        markers.dispose();
    });

    it('does not mark the output of a listing command (issue-detector-noisy)', () => {
        // Enter: the cursor is on the command line, the output is to come.
        const rows = ['luis@web:~$ cat /tmp/app.log'];
        const { term, decorations } = fakeTerminal(rows);
        const markers = new ErrorMarkers(term, { label: () => 'Ask the AI', onFix: vi.fn() });
        markers.noteCommand('cat /tmp/app.log');
        rows.push(...LOG, 'luis@web:~$ make');
        markers.schedule();
        vi.advanceTimersByTime(200);
        expect(decorations).toEqual([]);

        // The next command's errors are marked again.
        markers.noteCommand('make');
        rows.push('make: *** [all] Error 2', 'Error: build failed', 'luis@web:~$ ');
        markers.schedule();
        vi.advanceTimersByTime(200);
        expect(decorations.map((decoration) => rows[decoration.marker.line])).toEqual(['Error: build failed']);
        markers.dispose();
    });

    it('checks the rows before a command with the previous state, even if the command clears them', () => {
        const rows = ['luis@web:~$ ./deploy.sh'];
        const { term, decorations, erase } = fakeTerminal(rows);
        const markers = new ErrorMarkers(term, { label: () => 'Ask the AI', onFix: vi.fn() });
        markers.noteCommand('./deploy.sh');
        rows.push('ERROR: deploy failed', 'luis@web:~$ clear; cat /tmp/app.log');
        // Enter comes before the scheduled pass.
        markers.noteCommand('clear; cat /tmp/app.log');
        expect(decorations.map((decoration) => rows[decoration.marker.line])).toEqual(['ERROR: deploy failed']);

        // After `clear` only the listing is on screen: the old marker went
        // with what it marked, and nothing new is marked.
        erase([...LOG, 'luis@web:~$ ']);
        markers.schedule();
        vi.advanceTimersByTime(200);
        expect(decorations.filter((decoration) => !decoration.disposed)).toHaveLength(0);
        markers.dispose();
    });

    it('reads the screen again after `clear` and drops the markers of what it erased', () => {
        const rows = ['luis@web:~$ ./a.sh', 'x', 'y', 'ERROR: old', 'z', 'luis@web:~$ ./b.sh'];
        const { term, decorations, erase } = fakeTerminal(rows);
        const onFix = vi.fn();
        const markers = new ErrorMarkers(term, { label: () => 'Ask the AI', onFix });
        markers.noteCommand('./a.sh');
        markers.noteCommand('clear; ./b.sh');
        expect(decorations.map((decoration) => [decoration.marker.line, decoration.disposed])).toEqual([[3, false]]);

        // `clear` then b's output, longer than what was on screen before.
        erase(['Error: new one', 'FATAL: other', 'a', 'b', 'c', 'd', 'e', 'luis@web:~$ ']);
        markers.schedule();
        vi.advanceTimersByTime(200);
        const live = decorations.filter((decoration) => !decoration.disposed);
        expect(decorations[0].disposed).toBe(true);
        expect(live.map((decoration) => decoration.marker.line)).toEqual([0, 1]);
        live[0].render().querySelector('button')?.click();
        expect(onFix).toHaveBeenCalledWith('Error: new one');
        markers.dispose();
    });

    it('draws its highlights again in the colours of a new colour scheme, on the same rows', () => {
        const rows = ['luis@web:~$ ./deploy.sh', ...LOG, 'luis@web:~$ '];
        const { term, decorations } = fakeTerminal(rows);
        const dark = terminalOverlayColors('dark').error;
        const light = terminalOverlayColors('light').error;
        let colors = dark;
        const onFix = vi.fn();
        const markers = new ErrorMarkers(term, { label: () => 'Ask the AI', onFix, colors: () => colors });
        markers.schedule();
        vi.advanceTimersByTime(200);
        expect(decorations.map((decoration) => decoration.backgroundColor)).toEqual([dark.background, dark.background, dark.background]);
        decorations.forEach((decoration) => decoration.render());

        colors = light;
        markers.recolor();
        expect(decorations.slice(0, 3).every((decoration) => decoration.disposed)).toBe(true);
        const live = decorations.filter((decoration) => !decoration.disposed);
        expect(live.map((decoration) => [decoration.marker.line, decoration.backgroundColor])).toEqual([
            [1, light.background], [2, light.background], [3, light.background]
        ]);
        const element = live[1].render();
        expect(element.querySelectorAll('button')).toHaveLength(1);
        element.querySelector('button')?.click();
        expect(onFix).toHaveBeenCalledWith(LOG[1]);

        markers.dispose();
        expect(decorations.every((decoration) => decoration.disposed)).toBe(true);
    });
});
