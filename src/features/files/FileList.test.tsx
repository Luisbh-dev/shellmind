import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import type { FileEntry } from '@shared/files';
import { setLanguage } from '@/i18n';
import { FileList } from './FileList';
import * as listing from './listing';
import { EMPTY_SELECTION } from './selection';

// Counts the formatting the list does.
vi.mock('./listing', async (importOriginal) => {
    const original = await importOriginal<typeof import('./listing')>();
    return {
        ...original,
        formatBytes: vi.fn(original.formatBytes),
        formatDate: vi.fn(original.formatDate),
        formatPermissions: vi.fn(original.formatPermissions)
    };
});

beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 720 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
});

afterAll(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    setLanguage('system');
});

beforeEach(() => {
    setLanguage('en');
    vi.mocked(listing.formatBytes).mockClear();
    vi.mocked(listing.formatDate).mockClear();
    vi.mocked(listing.formatPermissions).mockClear();
});

const entries: FileEntry[] = Array.from({ length: 20_000 }, (_, i) => ({
    name: `file-${String(i).padStart(5, '0')}.log`, isDir: false, isLink: false, size: i * 10, mtime: 1_700_000_000 + i, permissions: 0o644
}));
const keys = entries.map(listing.entryKey);

describe('FileList', () => {
    // perf-explorer-eager-row-format: every entry used to be formatted on each
    // filter keystroke, although only the rows on screen are rendered.
    it('formats only the rows it renders', () => {
        render(
            <FileList
                id="list"
                path="/var/log"
                entries={entries}
                keys={keys}
                selection={EMPTY_SELECTION}
                onSelectionChange={() => undefined}
                sort={{ key: 'name', direction: 'asc' }}
                onSort={() => undefined}
                language="en"
                maxEditBytes={2 * 1024 * 1024}
                onOpen={() => undefined}
                onAction={() => undefined}
                onUp={() => undefined}
                onDeleteSelection={() => undefined}
                onRenameFocused={() => undefined}
                gridRef={createRef<HTMLDivElement>()}
            />
        );
        const rows = screen.getAllByRole('row').length - 1;
        expect(rows).toBeGreaterThan(10);
        expect(rows).toBeLessThan(100);
        expect(screen.getByText('file-00000.log')).toBeInTheDocument();
        expect(screen.getAllByText('10 B').length).toBe(1);
        for (const format of [listing.formatBytes, listing.formatDate, listing.formatPermissions]) {
            expect(vi.mocked(format).mock.calls.length).toBeLessThanOrEqual(rows * 2);
        }
    });
});
