import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import type { WorkspaceServer } from '@/workspace/types';
import { ConfirmProvider, ToastProvider } from '@/components/ui';
import { setLanguage } from '@/i18n';
import { collectUnsavedWork, useAppStore } from '@/store/appStore';
import { entry, FakeFileServer, folder } from '../../../test/helpers/fakeFileServer';
import FileExplorer from './FileExplorer';

let mockServer: FakeFileServer;
vi.mock('@/lib/socket', () => ({ createSocket: () => mockServer.connect() }));

const SERVER: WorkspaceServer = { id: 7, name: 'web-1', ip: '10.0.0.7', type: 'linux' };

function renderExplorer(server: WorkspaceServer = SERVER, isActive = true) {
    const ui = (s: WorkspaceServer, active: boolean) => (
        <ToastProvider>
            <ConfirmProvider>
                <FileExplorer server={s} isActive={active} />
            </ConfirmProvider>
        </ToastProvider>
    );
    const view = render(ui(server, isActive));
    return { ...view, rerenderWith: (s: WorkspaceServer, active: boolean) => view.rerender(ui(s, active)) };
}

const grid = () => screen.findByRole('grid');
const rowNames = () => screen.queryAllByRole('row').slice(1).map((row) => within(row).getAllByRole('gridcell')[1].textContent);

beforeAll(() => {
    // jsdom has no layout: give the list a viewport so rows get rendered.
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 720 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
});

afterAll(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
});

beforeEach(() => {
    setLanguage('en');
    useAppStore.setState(useAppStore.getInitialState(), true);
    mockServer = new FakeFileServer();
    mockServer.tree.set('/', [folder('home')]);
    mockServer.tree.set('/home', [folder('demo')]);
    mockServer.tree.set('/home/demo', [
        folder('projects'),
        folder('secret'),
        entry('notes.txt', { size: 12 }),
        entry('.bashrc', { size: 220 }),
        entry('app.log', { size: 3 * 1024 * 1024 }),
    ]);
    mockServer.tree.set('/home/demo/projects', [entry('readme.md')]);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('FileExplorer', () => {
    it('starts in the home folder of the file session', async () => {
        renderExplorer();
        expect(await screen.findByRole('grid', { name: 'Files in /home/demo' })).toBeInTheDocument();
        expect(rowNames()).toEqual(['projects', 'secret', '.bashrc', 'app.log', 'notes.txt']);
        expect(mockServer.requestsOf('files-list')).toEqual([{ path: '/home/demo' }]);
        expect(mockServer.socket.emitted[0]).toEqual({ event: 'start-ssh', payload: { serverId: 7, purpose: 'files' } });
        expect(screen.getByRole('navigation', { name: 'Current folder' })).toHaveTextContent('/homedemo');
    });

    it('shows a connection failure instead of an empty folder, and reconnects', async () => {
        mockServer.session = { kind: 'error', message: 'All configured authentication methods failed' };
        renderExplorer();
        expect(await screen.findByText('Could not open the file session')).toBeInTheDocument();
        expect(screen.getByText('All configured authentication methods failed')).toBeInTheDocument();
        expect(screen.queryByText('This folder is empty')).toBeNull();

        mockServer.session = { kind: 'ready' };
        fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
        expect(await screen.findByRole('grid', { name: 'Files in /home/demo' })).toBeInTheDocument();
        expect(mockServer.sockets).toHaveLength(2);
        expect(mockServer.closed).toEqual([mockServer.sockets[0]]);
    });

    it('names a coded connection failure in the UI language, with the server text after it', async () => {
        mockServer.session = {
            kind: 'error',
            message: 'Auth failed: All configured authentication methods failed',
            error: { code: 'AUTH_FAILED', message: 'All configured authentication methods failed' },
        };
        renderExplorer();
        expect(await screen.findByText('Could not open the file session')).toBeInTheDocument();
        expect(screen.getByText('The server rejected the saved credentials. (All configured authentication methods failed)')).toBeInTheDocument();
    });

    // FE-03: trusting used to delete the pin and reconnect, which pinned
    // whatever key answered next instead of the one the user compared.
    it('explains a changed host key and pins exactly the key the user confirmed', async () => {
        mockServer.session = { kind: 'host-key-mismatch', host: '10.0.0.7', port: 22, keyType: 'ssh-ed25519', expected: 'SHA256:old', actual: 'SHA256:new' };
        const fetchMock = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        renderExplorer();

        expect(await screen.findByText('The host key of 10.0.0.7:22 has changed')).toBeInTheDocument();
        expect(screen.getByText('SHA256:old')).toBeInTheDocument();
        expect(screen.getByText('SHA256:new')).toBeInTheDocument();

        mockServer.session = { kind: 'ready' };
        fireEvent.click(screen.getByRole('button', { name: 'Trust the new key and reconnect' }));
        const dialog = await screen.findByRole('alertdialog', { name: 'Trust the new host key?' });
        expect(dialog).toHaveTextContent('only the key SHA256:new is trusted');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Trust and reconnect' }));
        expect(await screen.findByRole('grid', { name: 'Files in /home/demo' })).toBeInTheDocument();

        // Sent on the file socket that saw the mismatch, with both keys; no pin is deleted.
        expect(mockServer.sockets[0].emitted.filter((e) => e.event === 'trust-host-key').map((e) => e.payload)).toEqual([
            { serverId: 7, host: '10.0.0.7', port: 22, keyType: 'ssh-ed25519', expected: 'SHA256:old', actual: 'SHA256:new' }
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mockServer.sockets).toHaveLength(2);
    });

    it('shows the keys again when the pin changed meanwhile, and stays put on other refusals', async () => {
        const mismatch = { kind: 'host-key-mismatch' as const, host: '10.0.0.7', port: 22, keyType: 'ssh-ed25519', expected: 'SHA256:old', actual: 'SHA256:new' };
        mockServer.session = mismatch;
        mockServer.handle('trust-host-key', () => ({ ok: false, code: 'HOST_KEY_CHANGED', error: 'changed' }));
        renderExplorer();
        const trust = async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Trust the new key and reconnect' }));
            fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Trust and reconnect' }));
        };

        mockServer.session = { ...mismatch, expected: 'SHA256:new', actual: 'SHA256:third' };
        await trust();
        expect(await screen.findByText('The pinned key changed again in the meantime. Compare the keys shown now before trusting one.')).toBeInTheDocument();
        expect(await screen.findByText('SHA256:third')).toBeInTheDocument();
        expect(mockServer.sockets).toHaveLength(2);

        mockServer.handle('trust-host-key', () => ({ ok: false, code: 'NOT_ON_ROUTE', error: '10.0.0.7:22 is not on the route to this server.' }));
        await trust();
        expect(await screen.findByText('10.0.0.7:22 is not on the route to this server.')).toBeInTheDocument();
        expect(mockServer.sockets).toHaveLength(2);
    });

    // FE-14: the failure of a navigation the user already moved on from was toasted.
    it('says nothing about a slow folder that failed after another one was opened', async () => {
        let failSecret: () => void = () => undefined;
        mockServer.handle('files-list', (payload) => payload.path === '/home/demo/secret'
            ? new Promise((resolve) => { failSecret = () => resolve({ ok: false, error: { code: 'PERMISSION_DENIED', message: '/home/demo/secret: permission denied' } }); })
            : { ok: true, data: { path: payload.path, entries: mockServer.tree.get(String(payload.path)) ?? [], truncated: false } });
        renderExplorer();
        await grid();
        fireEvent.doubleClick(screen.getByText('secret'));
        fireEvent.doubleClick(screen.getByText('projects'));
        expect(await screen.findByRole('grid', { name: 'Files in /home/demo/projects' })).toBeInTheDocument();

        await act(async () => failSecret());
        expect(screen.queryByText('Could not open /home/demo/secret')).toBeNull();
        expect(screen.getByRole('grid', { name: 'Files in /home/demo/projects' })).toBeInTheDocument();
        expect(rowNames()).toEqual(['readme.md']);
    });

    it('keeps the path and the listing when a folder cannot be opened', async () => {
        mockServer.handle('files-list', (payload) => payload.path === '/home/demo/secret'
            ? { ok: false, error: { code: 'PERMISSION_DENIED', message: '/home/demo/secret: permission denied' } }
            : { ok: true, data: { path: payload.path, entries: mockServer.tree.get(String(payload.path)) ?? [], truncated: false } });
        renderExplorer();
        await grid();
        fireEvent.doubleClick(screen.getByText('secret'));

        expect(await screen.findByText('Could not open /home/demo/secret')).toBeInTheDocument();
        expect(screen.getByRole('grid', { name: 'Files in /home/demo' })).toBeInTheDocument();
        expect(rowNames()).toContain('notes.txt');
    });

    it('shows only the latest of overlapping listings', async () => {
        renderExplorer();
        await grid();
        mockServer.handle('files-list', (payload) => {
            const result = { ok: true as const, data: { path: String(payload.path), entries: mockServer.tree.get(String(payload.path)) ?? [], truncated: false } };
            // The first (slow) request answers last.
            const delay = payload.path === '/home/demo/projects' ? 80 : 5;
            return new Promise((resolve) => setTimeout(() => resolve(result), delay));
        });
        fireEvent.doubleClick(screen.getByText('projects'));
        fireEvent.click(screen.getByRole('button', { name: 'Go to the parent folder (Backspace)' }));

        expect(await screen.findByRole('grid', { name: 'Files in /home' })).toBeInTheDocument();
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(screen.getByRole('grid', { name: 'Files in /home' })).toBeInTheDocument();
        expect(rowNames()).toEqual(['demo']);
    });

    it('keeps one session across re-renders, new server objects and tab switches', async () => {
        const { rerenderWith } = renderExplorer();
        await grid();
        rerenderWith({ ...SERVER, osDetail: 'Ubuntu 24.04' } as WorkspaceServer, true);
        rerenderWith({ ...SERVER }, false);
        rerenderWith({ ...SERVER }, true);
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        expect(mockServer.sockets).toHaveLength(1);
        expect(mockServer.closed).toHaveLength(0);
    });

    it('is fully usable from the keyboard', async () => {
        renderExplorer();
        const list = await grid();
        act(() => list.focus());
        // Entering the list puts the cursor on the first row without selecting it.
        const [, firstRow, secondRow] = screen.getAllByRole('row');
        expect(list).toHaveAttribute('aria-activedescendant', firstRow.id);
        expect(firstRow).toHaveAttribute('aria-selected', 'false');
        fireEvent.keyDown(list, { key: 'ArrowDown' });
        expect(list).toHaveAttribute('aria-activedescendant', secondRow.id);
        expect(secondRow).toHaveAttribute('aria-selected', 'true');
        fireEvent.keyDown(list, { key: 'Home' });
        expect(firstRow).toHaveAttribute('aria-selected', 'true');

        fireEvent.keyDown(list, { key: 'Enter' });
        expect(await screen.findByRole('grid', { name: 'Files in /home/demo/projects' })).toBeInTheDocument();
        fireEvent.keyDown(screen.getByRole('grid'), { key: 'Backspace' });
        expect(await screen.findByRole('grid', { name: 'Files in /home/demo' })).toBeInTheDocument();

        const again = screen.getByRole('grid');
        fireEvent.keyDown(again, { key: 'a', ctrlKey: true });
        expect(screen.getAllByRole('row').slice(1).every((row) => row.getAttribute('aria-selected') === 'true')).toBe(true);
        expect(screen.getByText('5 selected (3 MB)')).toBeInTheDocument();
        fireEvent.keyDown(again, { key: 'Escape' });
        expect(screen.queryByText(/selected \(/)).toBeNull();

        fireEvent.keyDown(again, { key: 'n' });
        fireEvent.keyDown(again, { key: 'F2' });
        expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('notes.txt');
    });

    it('never moves the rows when the selection changes (double-click lands on the same row)', async () => {
        renderExplorer();
        const list = await grid();
        const above = () => {
            const items: Element[] = [];
            for (let node = list.previousElementSibling; node; node = node.previousElementSibling) items.push(node);
            return items;
        };
        const before = above();
        fireEvent.click(screen.getByText('notes.txt'));
        expect(screen.getByText('1 selected (12 B)')).toBeInTheDocument();
        expect(above()).toEqual(before);
        fireEvent.doubleClick(screen.getByText('projects'));
        expect(await screen.findByRole('grid', { name: 'Files in /home/demo/projects' })).toBeInTheDocument();
    });

    it('selects with Ctrl/Shift clicks and deletes in bulk after showing what goes', async () => {
        renderExplorer();
        await grid();
        fireEvent.click(screen.getByText('projects'));
        fireEvent.click(screen.getByText('notes.txt'), { ctrlKey: true });
        expect(screen.getByText('2 selected (12 B)')).toBeInTheDocument();
        fireEvent.click(screen.getByText('app.log'), { shiftKey: true });
        expect(screen.getByText('2 selected (3 MB)')).toBeInTheDocument();

        fireEvent.click(screen.getByText('projects'));
        fireEvent.click(screen.getByText('.bashrc'), { shiftKey: true });
        fireEvent.click(screen.getByRole('button', { name: 'Delete (3)' }));
        const dialog = await screen.findByText('Delete 3 items?');
        expect(dialog).toBeInTheDocument();
        expect(await screen.findByText('This permanently deletes 3 files and 1 folder (4 KB).')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(mockServer.requestsOf('files-delete')).toHaveLength(1));
        expect(mockServer.requestsOf('files-delete')[0]).toEqual({
            items: [
                { path: '/home/demo/projects', isDir: true, isLink: false },
                { path: '/home/demo/secret', isDir: true, isLink: false },
                { path: '/home/demo/.bashrc', isDir: false, isLink: false },
            ],
        });
        expect(mockServer.requestsOf('files-count')[0]).toEqual(mockServer.requestsOf('files-delete')[0]);
        expect(await screen.findByText('Deleted 3 items')).toBeInTheDocument();
    });

    it('asks before replacing uploads and can keep both files', async () => {
        renderExplorer();
        const list = await grid();
        const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
        const fresh = new File(['new'], 'fresh.txt', { type: 'text/plain' });
        fireEvent.drop(list, { dataTransfer: { files: [file, fresh], types: ['Files'] } });

        expect(await screen.findByText('“notes.txt” already exists')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Keep both' }));

        await waitFor(() => expect(mockServer.requestsOf('files-upload-end')).toHaveLength(2));
        expect(mockServer.requestsOf('files-upload-start')).toEqual([
            { path: '/home/demo/notes (1).txt', size: 5, overwrite: false },
            { path: '/home/demo/fresh.txt', size: 3, overwrite: false },
        ]);
        // Four-byte chunks (the fake's chunk size), in order.
        expect(mockServer.requestsOf('files-upload-chunk').map((chunk) => chunk.seq)).toEqual([0, 1, 0]);
        expect(await screen.findByRole('region', { name: 'Transfers' })).toBeInTheDocument();
    });

    it('renders only the visible part of a very large folder', async () => {
        mockServer.tree.set('/home/demo', Array.from({ length: 10_000 }, (_, i) => entry(`file-${i}.log`)));
        renderExplorer();
        const list = await grid();
        expect(list).toHaveAttribute('aria-rowcount', '10001');
        const rendered = screen.getAllByRole('row').length;
        expect(rendered).toBeGreaterThan(10);
        expect(rendered).toBeLessThan(80);
        expect(screen.getByText('file-0.log')).toBeInTheDocument();
        expect(screen.getByText('10,000 items')).toBeInTheDocument();
    });

    it('says a folder is empty only after listing it', async () => {
        mockServer.tree.set('/home/demo', []);
        renderExplorer();
        expect(await screen.findByText('This folder is empty')).toBeInTheDocument();
    });

    it('filters by name and hides dot files on request', async () => {
        renderExplorer();
        await grid();
        fireEvent.click(screen.getByRole('button', { name: 'Hide hidden files' }));
        expect(rowNames()).not.toContain('.bashrc');
        fireEvent.change(screen.getByRole('searchbox', { name: 'Filter by name' }), { target: { value: 'NOTE' } });
        expect(rowNames()).toEqual(['notes.txt']);
        fireEvent.change(screen.getByRole('searchbox', { name: 'Filter by name' }), { target: { value: 'zzz' } });
        expect(screen.getByText('No items match “zzz”')).toBeInTheDocument();
    });

    it('warns when the transport is not encrypted', async () => {
        mockServer.info = { ...mockServer.info, protocol: 'ftp', transport: 'ftp', secure: false, home: '/home/demo' };
        renderExplorer({ ...SERVER, type: 'ftp' });
        expect(await screen.findByText(/Plain FTP: the password and the files travel unencrypted/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Hide this warning' }));
        expect(screen.queryByText(/Plain FTP/)).toBeNull();
    });

    it('keeps the editor and its unsaved text when the session drops, and saves after reconnecting', async () => {
        mockServer.contents.set('/home/demo/notes.txt', new TextEncoder().encode('hello\n'));
        renderExplorer();
        await grid();
        fireEvent.doubleClick(screen.getByText('notes.txt'));
        const content = await screen.findByRole('textbox', { name: 'Contents of notes.txt' });
        const view = EditorView.findFromDOM(content as HTMLElement)!;
        act(() => { view.dispatch({ changes: { from: view.state.doc.length, insert: '# second\n' } }); });

        // A network blip: socket.io reconnects the same socket on its own.
        act(() => mockServer.socket.fire('disconnect', 'transport close'));
        const editor = screen.getByRole('dialog', { name: /^Editing notes\.txt/ });
        expect(within(editor).getByText('Reconnecting…')).toBeInTheDocument();
        act(() => mockServer.socket.open());
        await waitFor(() => expect(within(editor).queryByText('Reconnecting…')).toBeNull());

        // The SSH connection ends: the editor stays, offering to reconnect.
        act(() => mockServer.socket.fire('ssh-closed'));
        expect(within(editor).getByRole('status')).toHaveTextContent('Your unsaved changes are kept here');
        expect(within(editor).getByRole('button', { name: /Save/ })).toBeDisabled();
        fireEvent.click(within(editor).getByRole('button', { name: 'Reconnect' }));
        await waitFor(() => expect(mockServer.sockets).toHaveLength(2));
        await waitFor(() => expect(within(editor).getByRole('button', { name: /Save/ })).toBeEnabled());

        expect(view.state.doc.toString()).toBe('hello\n# second\n');
        expect(mockServer.requestsOf('files-read')).toHaveLength(1);
        fireEvent.keyDown(view.contentDOM, { key: 's', ctrlKey: true });
        await waitFor(() => expect(mockServer.requestsOf('files-write')).toHaveLength(1));
        expect(mockServer.socket.emitted.some((sent) => sent.event === 'files-write')).toBe(true);
        expect(new TextDecoder().decode(mockServer.contents.get('/home/demo/notes.txt'))).toBe('hello\n# second\n');
    });

    it('edits the path with Ctrl+L, but not from a dialog on top of the list', async () => {
        renderExplorer();
        const list = await grid();
        act(() => list.focus());
        fireEvent.keyDown(list, { key: 'F2' });
        expect(await screen.findByRole('textbox', { name: 'Name' })).toBeInTheDocument();
        const name = screen.getByRole('textbox', { name: 'Name' });
        name.focus();
        fireEvent.keyDown(name, { key: 'l', ctrlKey: true });
        expect(screen.queryByRole('textbox', { name: 'Folder path' })).toBeNull();
        expect(document.activeElement).toBe(name);

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull());
        list.focus();
        // F6 is the app's (it moves between the connections, the workspace and the chat).
        const f6 = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
        act(() => { list.dispatchEvent(f6); });
        expect(f6.defaultPrevented).toBe(false);
        expect(screen.queryByRole('textbox', { name: 'Folder path' })).toBeNull();
        fireEvent.keyDown(list, { key: 'l', ctrlKey: true });
        expect(await screen.findByRole('textbox', { name: 'Folder path' })).toBeInTheDocument();
    });

    it('reports transfers still to finish as work that closing the server would lose', async () => {
        let finish: () => void = () => undefined;
        mockServer.handle('files-upload-start', () => new Promise((resolve) => {
            finish = () => resolve({ ok: true, data: { transferId: 'up-1', chunkSize: 4, window: 2 } });
        }));
        renderExplorer();
        const list = await grid();
        expect(collectUnsavedWork(SERVER.id)).toEqual([]);
        fireEvent.drop(list, { dataTransfer: { files: [new File(['data'], 'fresh.txt')], types: ['Files'] } });

        await waitFor(() => expect(collectUnsavedWork(SERVER.id)).toEqual(['1 file transfer in progress']));
        act(() => finish());
        await waitFor(() => expect(mockServer.requestsOf('files-upload-end')).toHaveLength(1));
        await waitFor(() => expect(collectUnsavedWork(SERVER.id)).toEqual([]));
    });

    it('tells apart an S3 object and a folder with the same name', async () => {
        mockServer.tree.set('/home/demo', [folder('reports'), entry('reports', { size: 2048 })]);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        renderExplorer();
        await grid();
        const [folderRow, fileRow] = screen.getAllByRole('row').slice(1);
        fireEvent.click(within(fileRow).getByText('reports'));
        expect(fileRow).toHaveAttribute('aria-selected', 'true');
        expect(folderRow).toHaveAttribute('aria-selected', 'false');
        expect(screen.getByText('1 selected (2 KB)')).toBeInTheDocument();
        expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false);
        errors.mockRestore();
    });

    it('is the connection state of an S3 server (no terminal), and only of S3 servers', async () => {
        const bucket: WorkspaceServer = { id: 9, name: 'backups', ip: '', type: 's3', s3_bucket: 'nightly' };
        mockServer.session = { kind: 'error', message: 'InvalidAccessKeyId' };
        const view = renderExplorer(bucket);
        await waitFor(() => expect(useAppStore.getState().connections[9]).toEqual({ state: 'error', error: 'InvalidAccessKeyId' }));

        mockServer.session = { kind: 'ready' };
        fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
        await waitFor(() => expect(useAppStore.getState().connections[9]).toEqual({ state: 'connected' }));

        // Gone with the panel, like a closed terminal.
        view.unmount();
        expect(useAppStore.getState().connections[9]).toBeUndefined();

        // SSH servers report through their terminal; the file session stays out.
        const sftp = renderExplorer();
        await grid();
        expect(useAppStore.getState().connections[SERVER.id]).toBeUndefined();
        sftp.unmount();

        // S3 sessions open without contacting the bucket: a refused first
        // listing (wrong key, missing bucket) is a failed connection.
        mockServer.handle('files-list', () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: '/: access denied (signature mismatch)' } }));
        renderExplorer(bucket);
        expect(await screen.findByText('Could not list this folder')).toBeInTheDocument();
        expect(useAppStore.getState().connections[9]).toEqual({ state: 'error', error: 'Permission denied: /: access denied (signature mismatch)' });
    });

    it('sorts from the keyboard: the column headers are in the Tab order', async () => {
        renderExplorer();
        await grid();
        const bySize = screen.getByRole('button', { name: 'Sort by Size' });
        expect(bySize).not.toHaveAttribute('tabindex', '-1');
        expect(screen.getByRole('checkbox', { name: 'Select all' })).not.toHaveAttribute('tabindex', '-1');
        bySize.focus();
        fireEvent.click(bySize);
        expect(bySize.closest('[role="columnheader"]')).toHaveAttribute('aria-sort', 'ascending');
        expect(rowNames()).toEqual(['projects', 'secret', 'notes.txt', '.bashrc', 'app.log']);
    });

    it('creates folders with validation', async () => {
        renderExplorer();
        await grid();
        fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
        const input = await screen.findByRole('textbox', { name: 'Name' });
        fireEvent.change(input, { target: { value: 'notes.txt' } });
        expect(screen.getByRole('alert')).toHaveTextContent('Something with this name already exists here.');
        fireEvent.change(input, { target: { value: 'logs' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(mockServer.requestsOf('files-mkdir')).toEqual([{ path: '/home/demo/logs' }]));
    });

    // NAME_MAX (255 bytes) is a rule of SFTP and FTP servers: S3 limits only
    // the whole key, so the dialog used to refuse names a bucket takes.
    it('lets an S3 folder name be as long as its key allows', async () => {
        const bucket: WorkspaceServer = { id: 9, name: 'backups', ip: '', type: 's3', s3_bucket: 'nightly' };
        mockServer.info = { ...mockServer.info, protocol: 's3', transport: 'https', secure: true };
        renderExplorer(bucket);
        await grid();
        fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
        const input = await screen.findByRole('textbox', { name: 'Name' });
        fireEvent.change(input, { target: { value: 'x'.repeat(1100) } });
        expect(screen.getByRole('alert')).toHaveTextContent('its full path in the bucket can be at most 1024 bytes');
        const accented = 'é'.repeat(200);
        fireEvent.change(input, { target: { value: accented } });
        expect(screen.queryByRole('alert')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(mockServer.requestsOf('files-mkdir')).toEqual([{ path: `/home/demo/${accented}` }]));
    });
});
