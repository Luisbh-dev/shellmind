import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import type { TerminalAppearance } from '@/features/appearance/terminalThemes';
import { useXterm } from './useXterm';

// xterm and its addons need a canvas; their options are what matters here.

const created: Array<{ options: Record<string, unknown> }> = [];

vi.mock('@xterm/xterm', () => ({
    Terminal: class {
        options: Record<string, unknown>;
        unicode = { activeVersion: '6' };
        constructor(options: Record<string, unknown>) {
            this.options = { ...options };
            created.push(this);
        }
        loadAddon() {}
        open() {}
        dispose() {}
    }
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));

const APPEARANCE = {
    scheme: { kind: 'dark', theme: { background: '#000' } },
    fontSize: 13,
    cursorStyle: 'block',
    cursorBlink: true,
    minimumContrastRatio: 1
} as unknown as TerminalAppearance;

function Host({ screenReaderMode }: { screenReaderMode: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useXterm(ref, { visible: false, appearance: APPEARANCE, screenReaderMode });
    return <div ref={ref} />;
}

describe('useXterm', () => {
    it('creates the terminal with screen reader mode as preferred and follows the preference live (UX-10)', () => {
        vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
        try {
            const { rerender } = render(<Host screenReaderMode />);
            expect(created).toHaveLength(1);
            expect(created[0].options.screenReaderMode).toBe(true);

            rerender(<Host screenReaderMode={false} />);
            expect(created[0].options.screenReaderMode).toBe(false);
            rerender(<Host screenReaderMode />);
            expect(created[0].options.screenReaderMode).toBe(true);
            // The same terminal: its scrollback stays.
            expect(created).toHaveLength(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
