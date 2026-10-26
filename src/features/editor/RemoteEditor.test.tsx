import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { openSearchPanel } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import type { FileStat } from '@shared/files';
import { ConfirmProvider, ToastProvider, hasOpenOverlay } from '@/components/ui';
import { setLanguage } from '@/i18n';
import { FileClientError, type FileClient } from '@/features/files/client';
import { collectUnsavedWork } from '@/store/appStore';
import RemoteEditor from './RemoteEditor';

const stat = (size: number, mtime = 1000): FileStat => ({ isDir: false, isLink: false, size, mtime, permissions: 0o644 });
const encode = (text: string) => new TextEncoder().encode(text);

function fakeClient(content: Uint8Array | Error) {
    return {
        read: vi.fn(async () => {
            if (content instanceof Error) throw content;
            return { path: '/etc/app.conf', data: content, stat: stat(content.length) };
        }),
        write: vi.fn(async (_path: string, data: Uint8Array, _expected?: unknown, _force?: boolean) => ({ path: '/etc/app.conf', stat: stat(data.length, 2000) }))
    };
}

type EditorProps = { path?: string; onClose?: () => void; onDownload?: () => void; active?: boolean; serverId?: number };

function renderEditor(client: ReturnType<typeof fakeClient>, props: EditorProps = {}) {
    const onClose = props.onClose ?? vi.fn();
    const onDownload = props.onDownload ?? vi.fn();
    const ui = (active: boolean) => (
        <ToastProvider>
            <ConfirmProvider>
                <RemoteEditor
                    serverId={props.serverId ?? 1}
                    client={client as unknown as FileClient}
                    active={active}
                    path={props.path ?? '/etc/app.conf'}
                    name="app.conf"
                    maxBytes={2 * 1024 * 1024}
                    onClose={onClose}
                    onDownload={onDownload}
                />
            </ConfirmProvider>
        </ToastProvider>
    );
    const view = render(ui(props.active ?? true));
    return { onClose, onDownload, setActive: (active: boolean) => view.rerender(ui(active)), unmount: view.unmount };
}

const pressWindow = (init: KeyboardEventInit) => act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init }));
});

async function editorView(): Promise<EditorView> {
    const content = await screen.findByRole('textbox', { name: 'Contents of app.conf' });
    const view = EditorView.findFromDOM(content as HTMLElement);
    if (!view) throw new Error('no editor');
    return view;
}

const type = (view: EditorView, text: string) => act(() => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
});
const pressSave = (view: EditorView) => fireEvent.keyDown(view.contentDOM, { key: 's', code: 'KeyS', ctrlKey: true });

beforeEach(() => setLanguage('en'));
afterEach(() => setLanguage('system'));

describe('RemoteEditor', () => {
    it('opens the file with highlighting for its type and saves with Ctrl+S', async () => {
        const client = fakeClient(encode('port=80\n'));
        renderEditor(client);
        const view = await editorView();
        expect(view.state.doc.toString()).toBe('port=80\n');
        expect(screen.getByRole('combobox', { name: 'Syntax' })).toHaveTextContent('INI / properties');
        expect(screen.getByText('LF')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();

        type(view, 'debug=true\n');
        expect(screen.getByRole('img', { name: 'Unsaved changes' })).toBeInTheDocument();
        pressSave(view);

        await waitFor(() => expect(client.write).toHaveBeenCalledTimes(1));
        const [path, data, expected, force] = client.write.mock.calls[0];
        expect(path).toBe('/etc/app.conf');
        expect(new TextDecoder().decode(data)).toBe('port=80\ndebug=true\n');
        expect(expected).toEqual({ size: 8, mtime: 1000 });
        expect(force).toBe(false);
        expect(await screen.findByText('Saved app.conf')).toBeInTheDocument();
        expect(screen.queryByRole('img', { name: 'Unsaved changes' })).toBeNull();

        // The next save expects the version just written.
        type(view, '#\n');
        pressSave(view);
        await waitFor(() => expect(client.write).toHaveBeenCalledTimes(2));
        expect(client.write.mock.calls[1][2]).toEqual({ size: 19, mtime: 2000 });
    });

    it('asks before overwriting a file that changed on the server', async () => {
        const client = fakeClient(encode('a\n'));
        client.write
            .mockRejectedValueOnce(new FileClientError({ code: 'CONFLICT', message: 'changed', current: stat(99, 1_700_000_000) }))
            .mockResolvedValueOnce({ path: '/etc/app.conf', stat: stat(4, 3000) });
        renderEditor(client);
        const view = await editorView();
        type(view, 'b\n');
        pressSave(view);

        expect(await screen.findByText('The file changed on the server')).toBeInTheDocument();
        expect(screen.getByText(/now 99 B/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
        await waitFor(() => expect(client.write).toHaveBeenCalledTimes(2));
        expect(client.write.mock.calls[1][3]).toBe(true);
    });

    it('keeps Windows line endings and the byte-order mark', async () => {
        const client = fakeClient(new Uint8Array([0xef, 0xbb, 0xbf, ...encode('a\r\nb\r\n')]));
        renderEditor(client, { path: 'C:/site/web.config' });
        const view = await editorView();
        expect(screen.getByText('CRLF')).toBeInTheDocument();
        expect(screen.getByText('UTF-8 BOM')).toBeInTheDocument();
        type(view, 'c\n');
        pressSave(view);
        await waitFor(() => expect(client.write).toHaveBeenCalled());
        expect([...(client.write.mock.calls[0][1] as Uint8Array)]).toEqual([0xef, 0xbb, 0xbf, ...encode('a\r\nb\r\nc\r\n')]);
    });

    it('refuses binary files and offers a download', async () => {
        const client = fakeClient(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]));
        const { onDownload } = renderEditor(client);
        expect(await screen.findByText('This looks like a binary file, so it cannot be edited here.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Download instead' }));
        expect(onDownload).toHaveBeenCalled();
    });

    it('explains the size limit', async () => {
        renderEditor(fakeClient(new FileClientError({ code: 'TOO_LARGE', message: 'too large' })));
        expect(await screen.findByText('The editor opens files up to 2 MB; this one is larger.')).toBeInTheDocument();
    });

    it('asks before discarding unsaved changes', async () => {
        const client = fakeClient(encode('x\n'));
        const { onClose } = renderEditor(client);
        const view = await editorView();
        type(view, 'y');
        fireEvent.click(screen.getByRole('button', { name: 'Close the editor' }));
        expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByText('Discard unsaved changes?')).toBeNull());
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Close the editor' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('reports unsaved changes as work that closing its server would lose', async () => {
        const client = fakeClient(encode('x\n'));
        const { unmount } = renderEditor(client);
        const view = await editorView();
        expect(collectUnsavedWork(1)).toEqual([]);

        type(view, 'y');
        expect(collectUnsavedWork(1)).toEqual(['Unsaved changes to /etc/app.conf']);
        expect(collectUnsavedWork(2)).toEqual([]);
        pressSave(view);
        await waitFor(() => expect(collectUnsavedWork(1)).toEqual([]));
        type(view, 'z');
        expect(collectUnsavedWork(1)).toEqual(['Unsaved changes to /etc/app.conf']);
        unmount();
        expect(collectUnsavedWork(1)).toEqual([]);
    });

    // Its server or tab in the background (App marks those panels hidden), or
    // the app behind a blocking layer: the keys are meant for something else.
    it('leaves Ctrl+S and Escape alone while it is not on screen', async () => {
        const client = fakeClient(encode('x\n'));
        const onClose = vi.fn();
        const ui = (hidden: boolean) => (
            <ToastProvider>
                <ConfirmProvider>
                    <div data-testid="panel" hidden={hidden}>
                        <RemoteEditor serverId={1} client={client as unknown as FileClient} path="/etc/app.conf" name="app.conf"
                            maxBytes={1024} onClose={onClose} onDownload={vi.fn()} />
                    </div>
                </ConfirmProvider>
            </ToastProvider>
        );
        const { rerender } = render(ui(false));
        const view = await editorView();
        type(view, 'y');
        act(() => view.contentDOM.blur());
        const keys = () => {
            const save = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
            act(() => {
                document.body.dispatchEvent(save);
                document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            });
            return save;
        };

        rerender(ui(true));
        expect(keys().defaultPrevented).toBe(false);
        // Behind a blocking layer (the app is inert), the same.
        rerender(ui(false));
        const panel = screen.getByTestId('panel');
        panel.setAttribute('inert', '');
        expect(keys().defaultPrevented).toBe(false);
        expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
        expect(client.write).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        // On screen again, Escape asks before discarding.
        panel.removeAttribute('inert');
        act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    });

    it('translates the search panel with the UI', async () => {
        setLanguage('es');
        renderEditor(fakeClient(encode('listen 80;\n')));
        const content = await screen.findByRole('textbox', { name: 'Contenido de app.conf' });
        const view = EditorView.findFromDOM(content as HTMLElement)!;
        act(() => { openSearchPanel(view); });
        expect(await screen.findByRole('button', { name: 'siguiente' })).toBeInTheDocument();
        expect(screen.getByText('distinguir mayúsculas')).toBeInTheDocument();
    });

    it('keeps unsaved text while the session is down and saves through the new one', async () => {
        const first = fakeClient(encode('server_name a;\n'));
        const second = fakeClient(encode('never read\n'));
        const onReconnect = vi.fn();
        const ui = (client: ReturnType<typeof fakeClient>, connection: 'ready' | 'connecting' | 'lost') => (
            <ToastProvider>
                <ConfirmProvider>
                    <RemoteEditor serverId={1} client={client as unknown as FileClient} connection={connection} onReconnect={onReconnect}
                        path="/etc/app.conf" name="app.conf" maxBytes={2 * 1024 * 1024} onClose={vi.fn()} onDownload={vi.fn()} />
                </ConfirmProvider>
            </ToastProvider>
        );
        const { rerender } = render(ui(first, 'ready'));
        const view = await editorView();
        type(view, '# second\n');

        rerender(ui(first, 'lost'));
        expect(screen.getByRole('status')).toHaveTextContent('Your unsaved changes are kept here');
        expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
        pressSave(view);
        expect(await screen.findByText('There is no connection to the server. Reconnect, then save again.')).toBeInTheDocument();
        expect(first.write).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
        expect(onReconnect).toHaveBeenCalled();

        rerender(ui(second, 'connecting'));
        expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
        rerender(ui(second, 'ready'));
        expect(screen.queryByText(/connection to the server was lost/)).toBeNull();
        // Same text, same document: nothing was read again.
        expect(view.state.doc.toString()).toBe('server_name a;\n# second\n');
        expect(second.read).not.toHaveBeenCalled();
        pressSave(view);
        await waitFor(() => expect(second.write).toHaveBeenCalledTimes(1));
        expect(new TextDecoder().decode(second.write.mock.calls[0][1])).toBe('server_name a;\n# second\n');
        expect(second.write.mock.calls[0][2]).toEqual({ size: 15, mtime: 1000 });
    });

    it('waits for the session before reading, and can try again after a failure', async () => {
        const client = fakeClient(encode('ok\n'));
        client.read.mockRejectedValueOnce(new FileClientError({ code: 'NOT_CONNECTED', message: 'No file session is open' }));
        const ui = (connection: 'ready' | 'lost') => (
            <ToastProvider>
                <ConfirmProvider>
                    <RemoteEditor serverId={1} client={client as unknown as FileClient} connection={connection}
                        path="/etc/app.conf" name="app.conf" maxBytes={1024} onClose={vi.fn()} onDownload={vi.fn()} />
                </ConfirmProvider>
            </ToastProvider>
        );
        const { rerender } = render(ui('lost'));
        expect(screen.getByText('Opening app.conf…')).toBeInTheDocument();
        expect(client.read).not.toHaveBeenCalled();
        rerender(ui('ready'));
        expect(await screen.findByText('No file session is open')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect((await editorView()).state.doc.toString()).toBe('ok\n');
        expect(client.read).toHaveBeenCalledTimes(2);
    });

    it('saves with Ctrl+S from anywhere in the dialog and keeps Tab inside it', async () => {
        const client = fakeClient(encode('a\n'));
        renderEditor(client);
        const view = await editorView();
        type(view, 'b\n');
        const toggle = screen.getByRole('button', { name: 'Read-only: off' });
        toggle.focus();
        const event = createEvent.keyDown(toggle, { key: 's', ctrlKey: true });
        fireEvent(toggle, event);
        expect(event.defaultPrevented).toBe(true);
        await waitFor(() => expect(client.write).toHaveBeenCalledTimes(1));

        const syntax = screen.getByRole('combobox', { name: 'Syntax' });
        syntax.focus();
        fireEvent.keyDown(syntax, { key: 'Tab' });
        expect(document.activeElement).toBe(toggle);
        fireEvent.keyDown(toggle, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(syntax);
    });

    it('closes right away without changes and can be made read-only', async () => {
        const client = fakeClient(encode('ro\n'));
        const { onClose } = renderEditor(client);
        const view = await editorView();
        fireEvent.click(screen.getByRole('button', { name: 'Read-only: off' }));
        expect(screen.getByRole('button', { name: 'Read-only: on' })).toHaveAttribute('aria-pressed', 'true');
        expect(view.contentDOM).toHaveAttribute('contenteditable', 'false');
        fireEvent.click(screen.getByRole('button', { name: 'Close the editor' }));
        expect(onClose).toHaveBeenCalled();
    });

    // FE-05 / UX-03: the editor was no overlay, so the app's shortcuts acted
    // behind it, and while hidden it still took Escape and Ctrl+S.
    it('is a registered overlay while shown, and handles no keys while hidden', async () => {
        const client = fakeClient(encode('a\n'));
        const { onClose, setActive } = renderEditor(client);
        const view = await editorView();
        expect(hasOpenOverlay()).toBe(true);
        type(view, 'b\n');

        setActive(false);
        expect(hasOpenOverlay()).toBe(false);
        pressWindow({ key: 's', ctrlKey: true });
        pressWindow({ key: 'Escape' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(client.write).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.queryByText('Discard unsaved changes?')).toBeNull();

        setActive(true);
        expect(hasOpenOverlay()).toBe(true);
        pressWindow({ key: 's', ctrlKey: true });
        await waitFor(() => expect(client.write).toHaveBeenCalledTimes(1));
    });

    it('leaves Escape inside the text to CodeMirror and closes on Escape elsewhere', async () => {
        const client = fakeClient(encode('listen 80;\n'));
        const { onClose } = renderEditor(client);
        const view = await editorView();

        fireEvent.keyDown(view.contentDOM, { key: 'Escape' });
        act(() => { openSearchPanel(view); });
        const search = await screen.findByRole('textbox', { name: 'Find' });
        fireEvent.keyDown(search, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull());
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(screen.getByRole('button', { name: 'Read-only: off' }), { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not save while a dialog is open on top of it', async () => {
        const client = fakeClient(encode('x\n'));
        renderEditor(client);
        const view = await editorView();
        type(view, 'y');
        fireEvent.click(screen.getByRole('button', { name: 'Close the editor' }));
        expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
        pressWindow({ key: 's', ctrlKey: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(client.write).not.toHaveBeenCalled();
    });
});
