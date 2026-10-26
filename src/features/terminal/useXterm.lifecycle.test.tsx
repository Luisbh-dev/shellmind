import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import type { TerminalAppearance } from '@/features/appearance/terminalThemes';
import { useXterm } from './useXterm';

// The renderer lifecycle of useXterm (arch-critical-test-gaps): WebGL only
// while visible, lost contexts recreated a few times a minute, the DOM
// renderer when WebGL is unavailable, debounced refits and link opening.
// xterm needs a real canvas, so it and its addons are stand-ins.

const xterm = vi.hoisted(() => {
    type Loss = () => void;
    class FakeWebgl {
        static instances: FakeWebgl[] = [];
        static unavailable = false;
        disposed = false;
        loss: Loss | null = null;
        constructor() {
            if (FakeWebgl.unavailable) throw new Error('WebGL2 not supported');
            FakeWebgl.instances.push(this);
        }
        onContextLoss(listener: Loss) {
            this.loss = listener;
            return { dispose() {} };
        }
        dispose() {
            this.disposed = true;
        }
    }
    class FakeTerminal {
        static instances: FakeTerminal[] = [];
        options: Record<string, unknown>;
        unicode = { activeVersion: '6' };
        addons: unknown[] = [];
        disposed = false;
        constructor(options: Record<string, unknown>) {
            this.options = { ...options };
            FakeTerminal.instances.push(this);
        }
        loadAddon(addon: unknown) {
            this.addons.push(addon);
        }
        open() {}
        dispose() {
            this.disposed = true;
        }
    }
    return {
        FakeWebgl,
        FakeTerminal,
        fit: vi.fn(),
        openLink: null as null | ((event: MouseEvent, uri: string) => void),
    };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = xterm.fit; } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({
    WebLinksAddon: class {
        constructor(handler: (event: MouseEvent, uri: string) => void) {
            xterm.openLink = handler;
        }
    }
}));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: xterm.FakeWebgl }));

const APPEARANCE = {
    scheme: { kind: 'dark', theme: { background: '#000' } },
    fontSize: 13,
    cursorStyle: 'block',
    cursorBlink: true,
    minimumContrastRatio: 1
} as unknown as TerminalAppearance;

let resize: (() => void) | null = null;
let size = { width: 800, height: 400 };

function Host({ visible, appearance = APPEARANCE }: { visible: boolean; appearance?: TerminalAppearance }) {
    const ref = useRef<HTMLDivElement>(null);
    const handle = useXterm(ref, { visible, appearance });
    return <div ref={ref} data-ready={handle ? 'yes' : 'no'} />;
}

const webgl = () => xterm.FakeWebgl.instances;
const term = () => xterm.FakeTerminal.instances[0];
const advance = (ms: number) => act(() => {
    vi.advanceTimersByTime(ms);
});

beforeEach(() => {
    vi.useFakeTimers();
    xterm.FakeWebgl.instances = [];
    xterm.FakeWebgl.unavailable = false;
    xterm.FakeTerminal.instances = [];
    xterm.fit.mockClear();
    resize = null;
    size = { width: 800, height: 400 };
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: () => void) {
            resize = callback;
        }
        observe() {}
        disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => size.width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => size.height);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('useXterm renderer', () => {
    it('renders with WebGL only while the terminal is on screen', () => {
        const { rerender } = render(<Host visible={false} />);
        expect(webgl()).toHaveLength(0);

        rerender(<Host visible />);
        expect(webgl()).toHaveLength(1);
        expect(term().addons).toContain(webgl()[0]);

        rerender(<Host visible={false} />);
        expect(webgl()[0].disposed).toBe(true);
    });

    it('recreates a lost WebGL context three times a minute at most, then keeps the DOM renderer', () => {
        const { rerender } = render(<Host visible />);
        for (let loss = 1; loss <= 3; loss += 1) {
            const lost = webgl()[loss - 1];
            act(() => lost.loss?.());
            expect(lost.disposed).toBe(true);
            advance(999);
            expect(webgl()).toHaveLength(loss);
            advance(1);
            expect(webgl()).toHaveLength(loss + 1);
            expect(term().addons).toContain(webgl()[loss]);
        }

        // A fourth loss within the minute: no more retries.
        act(() => webgl()[3].loss?.());
        advance(5000);
        expect(webgl()).toHaveLength(4);
        expect(webgl()[3].disposed).toBe(true);

        // Shown again later: WebGL gets a fresh chance.
        rerender(<Host visible={false} />);
        rerender(<Host visible />);
        expect(webgl()).toHaveLength(5);
    });

    it('forgets context losses older than a minute', () => {
        render(<Host visible />);
        for (let loss = 0; loss < 3; loss += 1) {
            act(() => webgl()[loss].loss?.());
            advance(1000);
        }
        advance(60_000);
        act(() => webgl()[3].loss?.());
        advance(1000);
        expect(webgl()).toHaveLength(5);
    });

    it('stays on the DOM renderer when WebGL is not available', () => {
        xterm.FakeWebgl.unavailable = true;
        const { container } = render(<Host visible />);
        expect(container.firstElementChild).toHaveAttribute('data-ready', 'yes');
        expect(term().disposed).toBe(false);
        expect(webgl()).toHaveLength(0);
    });

    it('drops a pending WebGL retry and the terminal on unmount', () => {
        const { unmount } = render(<Host visible />);
        act(() => webgl()[0].loss?.());
        unmount();
        advance(5000);
        expect(webgl()).toHaveLength(1);
        expect(term().disposed).toBe(true);
    });
});

describe('useXterm fit', () => {
    it('refits once a burst of container resizes settles', () => {
        render(<Host visible />);
        xterm.fit.mockClear();
        for (let frame = 0; frame < 5; frame += 1) {
            act(() => resize?.());
            advance(16);
        }
        expect(xterm.fit).not.toHaveBeenCalled();
        advance(60);
        expect(xterm.fit).toHaveBeenCalledTimes(1);
    });

    it('does not fit a container that has no size (hidden tab)', () => {
        size = { width: 0, height: 0 };
        render(<Host visible />);
        act(() => resize?.());
        advance(100);
        expect(xterm.fit).not.toHaveBeenCalled();
    });

    it('refits when the font size changes, and only then', () => {
        const { rerender } = render(<Host visible />);
        xterm.fit.mockClear();
        rerender(<Host visible appearance={{ ...APPEARANCE, cursorBlink: false }} />);
        expect(xterm.fit).not.toHaveBeenCalled();
        rerender(<Host visible appearance={{ ...APPEARANCE, fontSize: 16 }} />);
        expect(term().options.fontSize).toBe(16);
        expect(xterm.fit).toHaveBeenCalledTimes(1);
    });
});

describe('useXterm links', () => {
    it('opens only web links, in a new window without access to the app', () => {
        render(<Host visible={false} />);
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        const click = () => ({ preventDefault: vi.fn() }) as unknown as MouseEvent;

        const event = click();
        xterm.openLink?.(event, 'www.example.com/docs');
        expect(event.preventDefault).toHaveBeenCalled();
        expect(open).toHaveBeenCalledWith('https://www.example.com/docs', '_blank', 'noopener,noreferrer');

        open.mockClear();
        for (const uri of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url']) xterm.openLink?.(click(), uri);
        expect(open).not.toHaveBeenCalled();
    });
});
