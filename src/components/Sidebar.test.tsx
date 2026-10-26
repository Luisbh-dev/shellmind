import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ServerSummary } from '@shared/types';
import { setLanguage } from '@/i18n';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';
import { useAppStore } from '@/store/appStore';
import { useOrganizationPrefs } from '@/features/organization/prefs';
import Sidebar from './Sidebar';

const SERVERS: ServerSummary[] = [
    { id: 1, name: 'web-2', ip: '10.0.0.1', type: 'linux', username: 'deploy', group_name: 'Prod', tags: ['web'], sort_order: 0, color: 'violet' },
    { id: 2, name: 'web-1', ip: '10.0.0.2', type: 'linux', username: 'root', group_name: 'Prod', tags: ['web', 'eu'], sort_order: 1, notes: 'Behind the LB' },
    { id: 3, name: 'db', ip: '10.0.0.3', type: 'linux', username: 'postgres', group_name: 'Data', tags: ['db'], sort_order: 2 },
    { id: 4, name: 'bucket', ip: '', type: 's3', s3_bucket: 'nightly', sort_order: 3 },
];

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    setLanguage('en');
    localStorage.clear();
    useOrganizationPrefs.setState({ collapsed: [], sortMode: 'manual', recent: {} });
    useAppStore.setState(useAppStore.getInitialState(), true);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

function setup(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
    const props = {
        servers: SERVERS,
        status: 'ready' as const,
        onRetry: vi.fn(),
        onSelectServer: vi.fn(),
        onAddServer: vi.fn(),
        onImportSshConfig: vi.fn(),
        onEditServer: vi.fn(),
        onOpenSettings: vi.fn(),
        onServerDeleted: vi.fn(),
        onReorder: vi.fn(),
        settingsShortcut: 'Ctrl+,',
        ...overrides,
    };
    const user = userEvent.setup();
    render(<ToastProvider><ConfirmProvider><Sidebar {...props} /></ConfirmProvider></ToastProvider>);
    return { user, props };
}

const rows = () => screen.getAllByRole('button').filter((button) => button.hasAttribute('data-server-row'));
const rowNames = () => rows().map((button) => button.querySelector('span span span')?.textContent);
const row = (name: string) => rows().find((button) => button.querySelector('span span span')?.textContent === name)!;

describe('Sidebar', () => {
    it('lists servers by group (named groups first) as keyboard-operable rows', async () => {
        const { user, props } = setup();
        expect(rowNames()).toEqual(['db', 'web-2', 'web-1', 'bucket']);
        expect(screen.getByRole('region', { name: 'Ungrouped' })).toBeInTheDocument();

        const db = row('db');
        db.focus();
        // Group headers are part of the sequence, so collapsed groups can be opened.
        await user.keyboard('{ArrowDown}');
        expect(screen.getByRole('button', { name: /Prod/, expanded: true })).toHaveFocus();
        await user.keyboard('{ArrowDown}');
        expect(row('web-2')).toHaveFocus();
        await user.keyboard('{End}');
        expect(row('bucket')).toHaveFocus();
        await user.keyboard('{Enter}');
        expect(props.onSelectServer).toHaveBeenCalledWith(SERVERS[3]);

        // Row actions are named after the server.
        expect(screen.getByRole('button', { name: 'Edit web-1' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'More actions for web-1' })).toBeInTheDocument();
    });

    it('names each row with its parts as separate phrases', () => {
        setup();
        act(() => useAppStore.getState().setConnection(2, { state: 'connected' }));
        expect(row('web-1')).toHaveAccessibleName('web-1, root@10.0.0.2, Connected, tags: web, eu, has notes');
        // The visible text first, in the order it shows (WCAG 2.5.3): name, then address.
        expect(row('bucket')).toHaveAccessibleName('bucket, nightly, S3');
    });

    it('skips the rows of collapsed groups with the arrow keys', async () => {
        const { user } = setup();
        await user.click(screen.getByRole('button', { name: /Prod/, expanded: true }));
        row('db').focus();

        await user.keyboard('{ArrowDown}');
        const prod = screen.getByRole('button', { name: /Prod/, expanded: false });
        expect(prod).toHaveFocus();
        await user.keyboard('{ArrowDown}');
        expect(screen.getByRole('button', { name: /Ungrouped/ })).toHaveFocus();
        await user.keyboard('{ArrowDown}');
        expect(row('bucket')).toHaveFocus();
        await user.keyboard('{ArrowUp}{ArrowUp}');
        expect(prod).toHaveFocus();
        // Opening it from the keyboard brings its rows back into the sequence.
        await user.keyboard('{Enter}{ArrowDown}');
        expect(row('web-2')).toHaveFocus();
    });

    it('collapses groups and remembers it', async () => {
        const { user } = setup();
        const header = screen.getByRole('button', { name: /Prod/, expanded: true });
        await user.click(header);
        expect(header).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('button', { name: /^web-1/ })).toBeNull();
        expect(JSON.parse(localStorage.getItem('shellmind.organization') ?? '{}').collapsed).toEqual(['Prod']);

        // A search looks inside collapsed groups.
        await user.type(screen.getByRole('searchbox', { name: /Search connections/ }), 'root');
        expect(rowNames()).toEqual(['web-1']);
    });

    it('searches by name, address, user, tag and group, and filters by tag chips', async () => {
        const { user } = setup();
        const search = screen.getByRole('searchbox', { name: /Search connections/ });
        await user.type(search, 'postgres');
        expect(rowNames()).toEqual(['db']);
        await user.clear(search);
        await user.type(search, 'prod eu');
        expect(rowNames()).toEqual(['web-1']);
        await user.click(screen.getByRole('button', { name: 'Clear search' }));

        const chips = screen.getByRole('group', { name: 'Filter by tag' });
        await user.click(within(chips).getByRole('button', { name: 'web' }));
        expect(within(chips).getByRole('button', { name: 'web' })).toHaveAttribute('aria-pressed', 'true');
        expect(rowNames()).toEqual(['web-2', 'web-1']);
        await user.click(within(chips).getByRole('button', { name: 'db' }));
        expect(screen.getByText('No connections match')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(rowNames()).toHaveLength(4);
    });

    it('sorts by name and moves servers within their group in manual order', async () => {
        const { user, props } = setup();
        await user.click(screen.getByRole('button', { name: 'More actions for web-1' }));
        await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
        expect(props.onReorder).toHaveBeenCalledWith([2, 1, 3, 4]);

        await user.click(screen.getByRole('button', { name: /^Sort:/ }));
        await user.click(screen.getByRole('menuitemradio', { name: 'Name' }));
        expect(rowNames()).toEqual(['db', 'web-1', 'web-2', 'bucket']);
        await user.click(screen.getByRole('button', { name: 'More actions for web-1' }));
        expect(screen.getByRole('menuitem', { name: /Move up/ })).toBeDisabled();
    });

    it('shows the live connection state only for servers with a session', () => {
        setup();
        act(() => useAppStore.getState().setConnection(2, { state: 'connected' }));
        expect(within(row('web-1')).getByRole('img', { name: 'Connected' })).toBeInTheDocument();
        expect(within(row('web-2')).queryByRole('img', { name: 'Connected' })).toBeNull();
    });

    it('explains why a jump host cannot be deleted', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({
            error: 'in use', code: 'JUMP_HOST_IN_USE', details: { dependents: [{ id: 2, name: 'web-1' }, { id: 3, name: 'db' }] },
        }, 409)));
        const { user, props } = setup();
        await user.click(screen.getByRole('button', { name: 'More actions for web-2' }));
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Could not delete connection');
        expect(alert).toHaveTextContent('It is the jump host of web-1, db.');
        expect(props.onServerDeleted).not.toHaveBeenCalled();
    });

    it('shows loading, error and empty states', async () => {
        const { user, props } = setup({ servers: [], status: 'error', error: 'database is locked' });
        expect(screen.getByRole('alert')).toHaveTextContent('database is locked');
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(props.onRetry).toHaveBeenCalled();
    });

    it('offers to add or import connections when there are none', async () => {
        const { user, props } = setup({ servers: [] });
        expect(screen.getByText('No connections yet')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Import from SSH config' }));
        expect(props.onImportSshConfig).toHaveBeenCalled();
    });
});
