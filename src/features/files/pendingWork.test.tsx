import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { collectUnsavedWork } from '@/store/appStore';
import { useReportTransfers, useReportUnsavedFile } from './pendingWork';

describe('pending file work', () => {
    it('keeps a server with unsaved editors or unfinished transfers from closing without asking', () => {
        const editor = renderHook(({ dirty }) => useReportUnsavedFile(1, 'nginx.conf', dirty), { initialProps: { dirty: false } });
        const transfers = renderHook(({ count }) => useReportTransfers(1, count), { initialProps: { count: 0 } });
        expect(collectUnsavedWork(1)).toEqual([]);

        editor.rerender({ dirty: true });
        transfers.rerender({ count: 2 });
        expect(collectUnsavedWork(1)).toEqual(['Unsaved changes to nginx.conf', '2 file transfers in progress']);
        expect(collectUnsavedWork(2)).toEqual([]);
        transfers.rerender({ count: 1 });
        expect(collectUnsavedWork(1)).toEqual(['Unsaved changes to nginx.conf', '1 file transfer in progress']);

        act(() => {
            editor.rerender({ dirty: false });
            transfers.unmount();
        });
        expect(collectUnsavedWork(1)).toEqual([]);
        editor.unmount();
    });
});
