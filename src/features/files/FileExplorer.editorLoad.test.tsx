import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WorkspaceServer } from '@/workspace/types';
import { ConfirmProvider, ToastProvider } from '@/components/ui';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { entry, FakeFileServer, folder } from '../../../test/helpers/fakeFileServer';
import FileExplorer from './FileExplorer';

// The editor's code is a separate chunk: here it cannot be downloaded.
let mockServer: FakeFileServer;
vi.mock('@/lib/socket', () => ({ createSocket: () => mockServer.connect() }));
vi.mock('@/features/editor/RemoteEditor', () => {
    throw new TypeError('Failed to fetch dynamically imported module: RemoteEditor.js');
});

const SERVER: WorkspaceServer = { id: 7, name: 'web-1', ip: '10.0.0.7', type: 'linux' };

beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 720 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
});

beforeEach(() => {
    setLanguage('en');
    useAppStore.setState(useAppStore.getInitialState(), true);
    mockServer = new FakeFileServer();
    mockServer.tree.set('/', [folder('home')]);
    mockServer.tree.set('/home', [folder('demo')]);
    mockServer.tree.set('/home/demo', [entry('notes.txt', { size: 12 })]);
});

afterEach(() => {
    setLanguage('system');
    vi.restoreAllMocks();
});

describe('FileExplorer without the editor chunk', () => {
    it('reports the editor that cannot be loaded and keeps the file list', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const silence = (event: ErrorEvent) => event.preventDefault();
        window.addEventListener('error', silence);
        try {
            render(
                <ToastProvider>
                    <ConfirmProvider>
                        <FileExplorer server={SERVER} isActive />
                    </ConfirmProvider>
                </ToastProvider>
            );
            await screen.findByRole('grid', { name: 'Files in /home/demo' });
            fireEvent.doubleClick(screen.getByText('notes.txt'));

            // After the retries of the download (src/lib/lazy.tsx).
            const dialog = await screen.findByRole('dialog', { name: 'This window could not be opened' }, { timeout: 5000 });
            expect(screen.getByRole('grid', { name: 'Files in /home/demo' })).toBeInTheDocument();
            fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]);
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            expect(screen.getByText('notes.txt')).toBeInTheDocument();
        } finally {
            window.removeEventListener('error', silence);
        }
    });
});
