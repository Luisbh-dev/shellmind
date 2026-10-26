import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ClipboardUnavailableError, canUseClipboard, copyText } from './clipboard';
import { REVOKE_DELAY_MS, safeFileName, saveBlob, saveText } from './download';
import { formatBytes, formatDateTime, formatPercent } from './format';
import { isDesktopApp } from './platform';
import { useElementSize, useViewportWidth } from './useElementSize';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('saveBlob', () => {
    it('downloads through an object URL that is revoked only later, not right after click()', () => {
        vi.useFakeTimers();
        const createObjectURL = vi.fn(() => 'blob:x');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
        const clicks: Array<{ href: string; download: string }> = [];
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            clicks.push({ href: this.href, download: this.download });
        });

        saveBlob(new Blob(['x']), 'server.rdp');
        expect(clicks).toEqual([{ href: 'blob:x', download: 'server.rdp' }]);
        expect(revokeObjectURL).not.toHaveBeenCalled();
        vi.advanceTimersByTime(REVOKE_DELAY_MS);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');

        saveText('notes.txt', 'hello');
        expect(createObjectURL).toHaveBeenCalledTimes(2);
        expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    });

    it('makes names the file system accepts', () => {
        expect(safeFileName('web/1:prod?.rdp')).toBe('web_1_prod_.rdp');
        expect(safeFileName('   ')).toBe('download');
        expect(safeFileName('..', 'x')).toBe('x');
    });
});

describe('copyText', () => {
    it('rejects clearly when the page has no clipboard (plain http on the LAN)', async () => {
        vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
        expect(canUseClipboard()).toBe(false);
        await expect(copyText('x')).rejects.toBeInstanceOf(ClipboardUnavailableError);
    });

    it('writes the text when it can', async () => {
        const writeText = vi.fn(async () => undefined);
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
        await copyText('uptime');
        expect(writeText).toHaveBeenCalledWith('uptime');
    });
});

describe('formatBytes', () => {
    it('uses binary steps, one decimal below 100 and the UI language', () => {
        expect(formatBytes(0, 'en')).toBe('0 B');
        expect(formatBytes(Number.NaN, 'en')).toBe('0 B');
        expect(formatBytes(512, 'en')).toBe('512 B');
        expect(formatBytes(1536, 'en')).toBe('1.5 KB');
        expect(formatBytes(1536, 'es')).toBe('1,5 KB');
        expect(formatBytes(1024 ** 2, 'en')).toBe('1 MB');
        expect(formatBytes(1024 ** 2, 'en', { fixed: true })).toBe('1.0 MB');
        expect(formatBytes(150 * 1024 ** 3, 'en')).toBe('150 GB');
        expect(formatBytes(1024 ** 6, 'en')).toBe('1,024 PB');
    });

    it('formats percentages and dates in the given language', () => {
        expect(formatPercent(42.25, 'en')).toBe('42.3%');
        expect(formatPercent(42.25, 'es')).toBe('42,3%');
        expect(formatPercent(Number.NaN, 'en')).toBe('—');
        expect(formatDateTime(0, 'en')).toBe('—');
        expect(formatDateTime(Date.UTC(2026, 0, 2, 12), 'es')).toMatch(/2026/);
    });
});

describe('isDesktopApp', () => {
    it('tells Electron from a browser tab', () => {
        expect(isDesktopApp()).toBe(false);
        vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 ShellMind/1.0.0 Chrome/130 Electron/33.0.0 Safari/537.36' });
        expect(isDesktopApp()).toBe(true);
    });
});

describe('size hooks', () => {
    it('follow an element and the window', () => {
        let observed: (() => void) | null = null;
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: () => void) { observed = callback; }
            observe() { return undefined; }
            disconnect() { return undefined; }
        });
        function Probe() {
            const [ref, size] = useElementSize<HTMLDivElement>();
            const width = useViewportWidth();
            return <div ref={ref} data-testid="probe">{size.width}x{size.height} / {width}</div>;
        }
        render(<Probe />);
        const probe = screen.getByTestId('probe');
        Object.defineProperty(probe, 'clientWidth', { configurable: true, value: 300 });
        Object.defineProperty(probe, 'clientHeight', { configurable: true, value: 120 });
        act(() => observed?.());
        expect(probe).toHaveTextContent(`300x120 / ${window.innerWidth}`);

        act(() => {
            window.innerWidth = 800;
            window.dispatchEvent(new Event('resize'));
        });
        expect(probe).toHaveTextContent('300x120 / 800');
    });
});
