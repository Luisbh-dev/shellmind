import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ServerSummary, Snippet } from '@shared/types';
import { ToastProvider } from '@/components/ui';
import { setLanguage } from '@/i18n';
import { flushTerminalIssues, ingestTerminalOutput, resetTerminalIssues, useTerminalIssueStore } from '@/lib/terminalIssues';
import { maskTerminalSecrets } from '@/lib/terminalSecrets';
import { useAppStore } from '@/store/appStore';
import { appendTerminalOutput, clearTerminalOutput, readTerminalOutputSince, recentTerminalOutput } from '@/store/terminalOutput';
import { useSnippetHandoff } from './handoff';
import SnippetsModal from './SnippetsModal';
import { resetServersStore } from '@/store/servers';

const SERVERS: ServerSummary[] = [
    { id: 1, name: 'web-1', ip: '10.0.0.5', type: 'linux' },
    { id: 2, name: 'db-1', ip: '10.0.0.6', type: 'linux' },
    { id: 3, name: 'files', ip: '10.0.0.7', type: 'ftp' },
    { id: 4, name: 'bucket', ip: '', type: 's3' },
];

let snippets: Snippet[];
let nextId: number;
let calls: Array<{ method: string; path: string; body?: unknown }>;

const snippet = (overrides: Partial<Snippet> & Pick<Snippet, 'id' | 'name' | 'command'>): Snippet => ({
    description: null, tags: [], server_id: null, created_at: 1, updated_at: 1, ...overrides,
});

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function backend(input: RequestInfo | URL, init: RequestInit = {}): Response {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    const idMatch = /^\/api\/snippets\/(\d+)$/.exec(url.pathname);

    if (url.pathname === '/api/servers') return json({ data: SERVERS });
    if (url.pathname === '/api/snippets' && method === 'GET') return json({ data: snippets });
    if (url.pathname === '/api/snippets' && method === 'POST') {
        const created = snippet({ id: nextId++, ...body });
        snippets = [...snippets, created];
        return json({ data: created }, 201);
    }
    if (url.pathname === '/api/snippets/import') {
        const created = (body.snippets as Snippet[]).map((item) => snippet({ ...item, id: nextId++ }));
        snippets = [...snippets, ...created];
        return json({ data: { created: created.length, skipped: 0 } });
    }
    if (idMatch && method === 'DELETE') {
        snippets = snippets.filter((item) => item.id !== Number(idMatch[1]));
        return json({ message: 'deleted' });
    }
    return json({ error: 'unexpected' }, 500);
}

const webServer = SERVERS[0];

beforeEach(() => {
    setLanguage('en');
    resetServersStore();
    localStorage.clear();
    useAppStore.setState(useAppStore.getInitialState(), true);
    useSnippetHandoff.setState(useSnippetHandoff.getInitialState(), true);
    clearTerminalOutput(webServer.id);
    resetTerminalIssues(webServer.id);
    snippets = [];
    nextId = 100;
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => backend(input, init)));
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('snippets library', () => {
    it('offers the starter snippets on an empty library and imports the selected ones', async () => {
        render(<SnippetsModal onClose={vi.fn()} server={null} />);
        expect(await screen.findByRole('heading', { name: 'Starter snippets' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('checkbox', { name: 'Listening ports' }));
        fireEvent.click(screen.getByRole('button', { name: 'Import selected (5)' }));

        await screen.findByRole('heading', { name: 'Disk usage' });
        const imported = calls.find((call) => call.path === '/api/snippets/import')?.body as { snippets: Array<{ name: string; command: string }> };
        expect(imported.snippets.map((item) => item.name)).toEqual([
            'Disk usage', 'Top memory processes', 'Failed systemd units', 'Running containers', 'Tail the system log',
        ]);
        expect(imported.snippets[3].command).toContain('{{.Names}}');
        expect(within(screen.getByRole('list', { name: 'Snippets' })).getAllByRole('button')).toHaveLength(5);
    });

    it('remembers when the starter offer is dismissed', async () => {
        const { unmount } = render(<SnippetsModal onClose={vi.fn()} server={null} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
        expect(await screen.findByText(/Your library is empty/)).toBeInTheDocument();
        unmount();

        render(<SnippetsModal onClose={vi.fn()} server={null} />);
        expect(await screen.findByText(/Your library is empty/)).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Starter snippets' })).toBeNull();
    });

    it('fills in variables, previews the command and runs it in the active terminal', async () => {
        snippets = [snippet({ id: 5, name: 'Tail log', command: 'tail -n {{lines:200}} {{file}}', tags: ['logs'] })];
        const onClose = vi.fn();
        render(<SnippetsModal onClose={onClose} server={webServer} />);
        await screen.findByRole('heading', { name: 'Tail log' });

        fireEvent.click(screen.getByRole('button', { name: 'Run in web-1' }));
        expect(screen.getByRole('alert')).toHaveTextContent('Fill in: file');
        expect(useAppStore.getState().pendingCommands[1]).toBeUndefined();

        fireEvent.change(screen.getByRole('textbox', { name: 'file' }), { target: { value: '/var/log/nginx/error.log' } });
        expect(screen.getByRole('textbox', { name: 'lines' })).toHaveAttribute('placeholder', '200');
        expect(screen.getByLabelText('Command to run')).toHaveTextContent('tail -n 200 /var/log/nginx/error.log');

        fireEvent.click(screen.getByRole('button', { name: 'Run in web-1' }));
        expect(useAppStore.getState().pendingCommands[1]).toEqual([
            expect.objectContaining({ command: 'tail -n 200 /var/log/nginx/error.log', source: 'snippet' }),
        ]);
        expect(onClose).toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem('shellmind.snippets.values.5')!)).toEqual({ file: '/var/log/nginx/error.log' });
    });

    it('says whether the command was typed or waits for the terminal to connect', async () => {
        snippets = [snippet({ id: 6, name: 'Uptime', command: 'uptime' })];
        const view = render(<ToastProvider><SnippetsModal onClose={vi.fn()} server={webServer} /></ToastProvider>);
        await screen.findByRole('heading', { name: 'Uptime' });
        fireEvent.click(screen.getByRole('button', { name: 'Run in web-1' }));
        expect(await screen.findByText('Waiting for the terminal of web-1: it runs once the session is connected, or is dropped after 2 minutes')).toBeInTheDocument();
        view.unmount();

        useAppStore.getState().setConnection(1, { state: 'connected' });
        render(<ToastProvider><SnippetsModal onClose={vi.fn()} server={webServer} /></ToastProvider>);
        await screen.findByRole('heading', { name: 'Uptime' });
        fireEvent.click(screen.getByRole('button', { name: 'Run in web-1' }));
        expect(await screen.findByText('Sent to the terminal of web-1')).toBeInTheDocument();
        expect(useAppStore.getState().pendingCommands[1]).toHaveLength(2);
    });

    it('prefills the values used last time', async () => {
        localStorage.setItem('shellmind.snippets.values.5', JSON.stringify({ file: '/tmp/app.log', lines: '50' }));
        snippets = [snippet({ id: 5, name: 'Tail log', command: 'tail -n {{lines:200}} {{file}}' })];
        render(<SnippetsModal onClose={vi.fn()} server={webServer} />);
        expect(await screen.findByRole('textbox', { name: 'file' })).toHaveValue('/tmp/app.log');
        expect(screen.getByLabelText('Command to run')).toHaveTextContent('tail -n 50 /tmp/app.log');
    });

    it('filters by text and tags and only shows the snippets of other servers on request', async () => {
        snippets = [
            snippet({ id: 1, name: 'Disk usage', command: 'df -h', tags: ['disk'] }),
            snippet({ id: 2, name: 'Restart postgres', command: 'systemctl restart postgresql', tags: ['db'], server_id: 2 }),
            snippet({ id: 3, name: 'Containers', command: 'docker ps', tags: ['docker'] }),
        ];
        render(<SnippetsModal onClose={vi.fn()} server={webServer} />);
        const list = await screen.findByRole('list', { name: 'Snippets' });
        await screen.findByRole('heading', { name: 'Disk usage' });
        const names = () => within(list).queryAllByRole('button').map((button) => button.querySelector('span')?.textContent);

        expect(names()).toEqual(['Disk usage', 'Containers']);
        fireEvent.click(screen.getByRole('checkbox', { name: 'Include snippets of other servers' }));
        expect(names()).toEqual(['Disk usage', 'Restart postgres', 'Containers']);
        expect(within(list).getByText('db-1')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'docker', pressed: false }));
        expect(names()).toEqual(['Containers']);
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search snippets' }), { target: { value: 'POSTGRESQL' } });
        expect(names()).toEqual(['Restart postgres']);
        expect(screen.getByRole('button', { name: 'Run in web-1' })).toBeDisabled();
        expect(screen.getByText(/This snippet belongs to db-1/)).toBeInTheDocument();

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search snippets' }), { target: { value: 'nothing like this' } });
        expect(screen.getAllByText('No snippet matches these filters.').length).toBeGreaterThan(0);
    });

    it('moves through the list with the arrow keys', async () => {
        snippets = [snippet({ id: 1, name: 'First', command: 'a' }), snippet({ id: 2, name: 'Second', command: 'b' })];
        render(<SnippetsModal onClose={vi.fn()} server={null} />);
        await screen.findByRole('heading', { name: 'First' });
        const first = screen.getByRole('button', { name: /^First/ });
        expect(first).toHaveAttribute('tabindex', '0');
        fireEvent.keyDown(first, { key: 'ArrowDown' });
        expect(screen.getByRole('heading', { name: 'Second' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Second/ })).toHaveFocus();
    });

    it('creates a snippet with the editor', async () => {
        snippets = [snippet({ id: 1, name: 'Existing', command: 'true' })];
        render(<SnippetsModal onClose={vi.fn()} server={webServer} />);
        await screen.findByRole('heading', { name: 'Existing' });

        fireEvent.click(screen.getByRole('button', { name: 'New snippet' }));
        const name = screen.getByRole('textbox', { name: 'Name' });
        expect(name).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: 'Save snippet' }));
        expect(screen.getByText('Give the snippet a name.')).toBeInTheDocument();
        expect(calls.some((call) => call.method === 'POST')).toBe(false);

        fireEvent.change(name, { target: { value: 'Restart service' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), { target: { value: 'sudo systemctl restart {{service:nginx}}\n' } });
        expect(screen.getByText('Variables: service = nginx')).toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: 'Tags' }), { target: { value: 'web, nginx,, ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save snippet' }));

        await screen.findByRole('heading', { name: 'Restart service' });
        expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
            name: 'Restart service',
            description: null,
            command: 'sudo systemctl restart {{service:nginx}}\n',
            tags: ['web', 'nginx'],
            server_id: null,
        });
    });

    it('duplicates and deletes snippets', async () => {
        vi.stubGlobal('confirm', vi.fn(() => true));
        snippets = [snippet({ id: 1, name: 'Uptime', command: 'uptime', tags: ['basic'] })];
        render(<SnippetsModal onClose={vi.fn()} server={null} />);
        await screen.findByRole('heading', { name: 'Uptime' });

        fireEvent.click(screen.getByRole('button', { name: 'Duplicate snippet' }));
        expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Uptime (copy)');
        expect(screen.getByRole('textbox', { name: 'Tags' })).toHaveValue('basic');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        fireEvent.click(screen.getByRole('button', { name: 'Delete snippet' }));
        await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/snippets/1')).toBe(true));
        expect(await screen.findByText(/Your library is empty/)).toBeInTheDocument();
    });

    it('hands the filled command to multi-exec', async () => {
        snippets = [snippet({ id: 9, name: 'Ping', command: 'ping -c {{count:3}} {{host:1.1.1.1}}' })];
        render(<SnippetsModal onClose={vi.fn()} server={null} />);
        await screen.findByRole('heading', { name: 'Ping' });
        expect(screen.getByRole('button', { name: 'Run in terminal' })).toBeDisabled();
        expect(screen.getByText('Select a connection to run it in its terminal.')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Run on several servers…' }));
        expect(useSnippetHandoff.getState().draft).toEqual({ command: 'ping -c {{count:3}} {{host:1.1.1.1}}', values: {}, marks: { marked: [], unmarked: [] }, snippet: { id: 9, name: 'Ping', serverId: null }, serverIds: undefined });
        expect(useAppStore.getState().activeActionId).toBe('multiexec');
    });

    it('keeps a scoped snippet on its own server in multi-exec', async () => {
        snippets = [
            snippet({ id: 1, name: 'Vacuum', command: 'vacuumdb --all', server_id: 2 }),
            snippet({ id: 2, name: 'List uploads', command: 'ls', server_id: 3 }),
        ];
        render(<SnippetsModal onClose={vi.fn()} server={null} />);
        await screen.findByRole('heading', { name: 'Vacuum' });
        fireEvent.click(screen.getByRole('button', { name: 'Open in multi-exec…' }));
        expect(useSnippetHandoff.getState().draft).toEqual({ command: 'vacuumdb --all', values: {}, marks: { marked: [], unmarked: [] }, snippet: { id: 1, name: 'Vacuum', serverId: 2 }, serverIds: [2] });

        // An FTP server cannot be reached by multi-exec.
        fireEvent.click(screen.getByRole('button', { name: /^List uploads/ }));
        const button = await screen.findByRole('button', { name: 'Open in multi-exec…' });
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription('Multi-exec runs on SSH servers only, and this snippet belongs to files.');
    });

    it('never remembers or records the values of secret variables', async () => {
        localStorage.setItem('shellmind.snippets.values.5', JSON.stringify({ user: 'app', password: 'old-secret' }));
        snippets = [snippet({ id: 5, name: 'Dump', command: 'mysqldump -u {{user}} -p{{password}} {{db:app}}' })];
        render(<SnippetsModal onClose={vi.fn()} server={webServer} />);
        expect(await screen.findByRole('textbox', { name: 'user' })).toHaveValue('app');
        const password = screen.getByLabelText(/^password/);
        expect(password).toHaveAttribute('type', 'password');
        expect(password).toHaveValue('');
        expect(password).toHaveAccessibleDescription(/Secret: never recorded or remembered/);

        fireEvent.change(password, { target: { value: 's3cr3t' } });
        expect(screen.getByLabelText('Command to run')).toHaveTextContent('mysqldump -u app -p{{password}} app');
        fireEvent.click(screen.getByRole('button', { name: 'Run in web-1' }));
        // The terminal types the value (after a space, which keeps it out of
        // the shell history); what it records is the masked form.
        expect(useAppStore.getState().pendingCommands[1]).toEqual([
            expect.objectContaining({ command: ' mysqldump -u app -ps3cr3t app', display: 'mysqldump -u app -p{{password}} app', source: 'snippet' }),
        ]);
        expect(JSON.parse(localStorage.getItem('shellmind.snippets.values.5')!)).toEqual({ user: 'app' });
    });

    it('masks the secret value in what the AI chat reads of the terminal, which echoes it', async () => {
        snippets = [snippet({ id: 5, name: 'Set app password', command: 'echo "configuring app with {{password}}" && printf %s {{password}} > /tmp/app.pw' })];
        render(<SnippetsModal onClose={vi.fn()} server={webServer} />);
        fireEvent.change(await screen.findByLabelText(/^password/), { target: { value: 'TermSecret-4242-xyz' } });
        fireEvent.click(screen.getByRole('button', { name: 'Run in web-1' }));

        // The shell echoes the typed line (its line editor wrapping it at the
        // terminal width), and the command prints the value.
        appendTerminalOutput(1, 'demo:~$  echo "configuring app with TermSecret-4242-xyz" && printf %s TermSecret-4242-xy\r\nz > /tmp/app.pw\r\n');
        appendTerminalOutput(1, 'configuring app with TermSecret-4242-xyz\r\nerror: TermSecret-4242-xyz rejected\r\ndemo:~$ ');
        ingestTerminalOutput(1, 'error: TermSecret-4242-xyz rejected\r\n');
        flushTerminalIssues(1);
        const recent = recentTerminalOutput(1, 4000);
        expect(recent).toContain('configuring app with {{password}}');
        expect(recent).toContain('printf %s {{password}} > /tmp/app.pw');
        expect(recent).not.toContain('TermSecret');
        expect(readTerminalOutputSince(1, 0).text).not.toContain('TermSecret');
        expect(useTerminalIssueStore.getState().issues[1]?.map((issue) => issue.message)).toEqual(['error: {{password}} rejected']);

        // Closing the server forgets the values with its output.
        clearTerminalOutput(1);
        resetTerminalIssues(1);
        expect(maskTerminalSecrets(1, 'TermSecret-4242-xyz')).toBe('TermSecret-4242-xyz');
    });

    it('lets the user unmark a variable that only looks like a secret, and keeps its default', async () => {
        snippets = [snippet({ id: 7, name: 'Pin release', command: 'deploy --pin {{pin:v2}} --grep {{keyword:ssh-ed25519}}' })];
        render(<SnippetsModal onClose={vi.fn()} server={webServer} />);
        await screen.findByRole('heading', { name: 'Pin release' });
        // keyword is an ordinary variable; pin looks like a secret, but keeps its default.
        expect(screen.getByRole('textbox', { name: /^keyword/ })).toHaveAttribute('placeholder', 'ssh-ed25519');
        expect(screen.getByLabelText(/^pin/)).toHaveAttribute('type', 'password');
        expect(screen.getByLabelText('Command to run')).toHaveTextContent('deploy --pin {{pin}} --grep ssh-ed25519');

        const toggle = screen.getByRole('button', { name: 'Treat pin as a secret' });
        expect(toggle).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByRole('textbox', { name: /^pin/ })).toHaveAttribute('placeholder', 'v2');
        expect(screen.getByLabelText('Command to run')).toHaveTextContent('deploy --pin v2 --grep ssh-ed25519');

        fireEvent.click(screen.getByRole('button', { name: 'Run in web-1' }));
        expect(useAppStore.getState().pendingCommands[1]).toEqual([
            expect.objectContaining({ command: 'deploy --pin v2 --grep ssh-ed25519', source: 'snippet' }),
        ]);
        expect(useAppStore.getState().pendingCommands[1][0]).not.toHaveProperty('display');
    });

    it('treats a variable as secret when the user marks it, or when the snippet declares it', async () => {
        snippets = [snippet({ id: 6, name: 'Call API', command: 'curl -H "X-Key: {{key:secret}}" {{url}} -d {{body}}' })];
        render(<SnippetsModal onClose={vi.fn()} server={webServer} />);
        await screen.findByRole('heading', { name: 'Call API' });
        expect(screen.getByLabelText(/^key/)).toHaveAttribute('type', 'password');
        fireEvent.change(screen.getByLabelText(/^key/), { target: { value: 'k-123' } });
        fireEvent.change(screen.getByRole('textbox', { name: /^url/ }), { target: { value: 'https://api.local' } });
        fireEvent.change(screen.getByRole('textbox', { name: /^body/ }), { target: { value: 'token=abc' } });
        fireEvent.click(screen.getByRole('button', { name: 'Treat body as a secret' }));
        expect(screen.getByLabelText(/^body/)).toHaveAttribute('type', 'password');
        expect(screen.getByLabelText('Command to run')).toHaveTextContent('curl -H "X-Key: {{key}}" https://api.local -d {{body}}');

        fireEvent.click(screen.getByRole('button', { name: 'Run in web-1' }));
        expect(useAppStore.getState().pendingCommands[1]).toEqual([
            expect.objectContaining({ command: ' curl -H "X-Key: k-123" https://api.local -d token=abc', display: 'curl -H "X-Key: {{key}}" https://api.local -d {{body}}' }),
        ]);
        expect(JSON.parse(localStorage.getItem('shellmind.snippets.values.6')!)).toEqual({ url: 'https://api.local' });
    });

    it('offers only servers with a terminal as the scope of a snippet', async () => {
        snippets = [snippet({ id: 1, name: 'Existing', command: 'true' })];
        render(<SnippetsModal onClose={vi.fn()} server={null} />);
        await screen.findByRole('heading', { name: 'Existing' });
        fireEvent.click(screen.getByRole('button', { name: 'New snippet' }));
        fireEvent.click(within(screen.getByRole('group', { name: 'Available on' })).getByRole('combobox', { name: /All servers/ }));
        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
            expect.stringContaining('All servers'), expect.stringContaining('web-1'), expect.stringContaining('db-1'), expect.stringContaining('files'),
        ]);
    });

    it('explains a snippet the backend refuses in the user language', async () => {
        setLanguage('es');
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (new URL(String(input)).pathname === '/api/snippets' && init?.method === 'POST') {
                return json({ error: 'server #2 does not exist', code: 'INVALID_SNIPPET', details: { reason: 'serverNotFound' } }, 400);
            }
            return backend(input, init);
        }));
        snippets = [snippet({ id: 1, name: 'Existing', command: 'true' })];
        render(<SnippetsModal onClose={vi.fn()} server={null} />);
        await screen.findByRole('heading', { name: 'Existing' });
        fireEvent.click(screen.getByRole('button', { name: 'Nuevo snippet' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Vacuum' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Comando' }), { target: { value: 'vacuumdb --all' } });
        fireEvent.click(screen.getByRole('button', { name: 'Guardar snippet' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('El servidor de este snippet ya no existe. Elige otro.');
    });

    it('speaks Spanish', async () => {
        setLanguage('es');
        snippets = [snippet({ id: 1, name: 'Uptime', command: 'uptime' })];
        render(<SnippetsModal onClose={vi.fn()} server={webServer} />);
        await screen.findByRole('heading', { name: 'Uptime' });
        expect(screen.getByRole('button', { name: 'Ejecutar en web-1' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Nuevo snippet' })).toBeInTheDocument();
        expect(screen.getByRole('searchbox', { name: 'Buscar snippets' })).toBeInTheDocument();
    });
});
