import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DEFAULT_FLEET_SETTINGS, type FleetSnapshot } from '@shared/fleet';
import type { ServerSummary } from '@shared/types';
import { setLanguage } from '@/i18n';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';
import { applyBoard, resetFleetFeed } from '@/features/fleet/feed';
import { useOrganizationPrefs } from '@/features/organization/prefs';
import { useAppStore } from '@/store/appStore';
import Sidebar from './Sidebar';

// W7-S1: the fleet health dot of the sidebar rows.

const SERVERS: ServerSummary[] = [
    { id: 1, name: 'web-1', ip: '10.0.0.1', type: 'linux' },
    { id: 2, name: 'db-1', ip: '10.0.0.2', type: 'linux' },
    { id: 3, name: 'gw', ip: '10.0.0.3', type: 'linux' }
];

const snapshot = (serverId: number, overrides: Partial<FleetSnapshot>): FleetSnapshot => ({
    serverId, state: 'ok', issues: [], metrics: null, checkedAt: Date.now() - 60_000, lastSeenAt: Date.now() - 60_000, error: null,
    handshakeMs: null, durationMs: 1, failures: 0, hold: null, blocked: null, readAt: null, reachedVia: null, sshSeenAt: null, monitored: true, checking: false, nextCheckAt: null, ...overrides
});

beforeEach(() => {
    setLanguage('en');
    localStorage.clear();
    resetFleetFeed();
    useOrganizationPrefs.setState({ collapsed: [], sortMode: 'manual', recent: {} });
    useAppStore.setState(useAppStore.getInitialState(), true);
});

afterEach(() => {
    resetFleetFeed();
    setLanguage('system');
});

function renderSidebar() {
    render(
        <ToastProvider>
            <ConfirmProvider>
                <Sidebar
                    servers={SERVERS}
                    status="ready"
                    onRetry={vi.fn()}
                    onSelectServer={vi.fn()}
                    onAddServer={vi.fn()}
                    onImportSshConfig={vi.fn()}
                    onEditServer={vi.fn()}
                    onOpenSettings={vi.fn()}
                    onServerDeleted={vi.fn()}
                    onReorder={vi.fn()}
                    settingsShortcut="Ctrl+,"
                />
            </ConfirmProvider>
        </ToastProvider>
    );
}

describe('sidebar health dots', () => {
    it('mark the servers that need attention, and say why', () => {
        applyBoard({
            settings: { ...DEFAULT_FLEET_SETTINGS, enabled: true },
            snapshots: [
                snapshot(1, {}),
                snapshot(2, { state: 'critical', issues: [{ metric: 'disk', tone: 'critical', value: 97, mount: '/var' }] }),
                snapshot(3, { state: 'unreachable', error: { code: 'ECONNREFUSED', message: 'refused' } })
            ]
        });
        renderSidebar();
        const nav = screen.getByRole('navigation', { name: 'Saved connections' });
        const db = within(nav).getByRole('button', { name: /^db-1/ });
        expect(db).toHaveAccessibleName(expect.stringContaining('Health: Critical · /var 97% full · checked'));
        expect(within(db).getByRole('img', { name: /^Health: Critical/ })).toHaveAttribute('data-fleet-state', 'critical');
        expect(within(within(nav).getByRole('button', { name: /^gw/ })).getByRole('img', { name: /^Health: Unreachable/ })).toBeInTheDocument();
        // A healthy server gets no dot.
        expect(within(within(nav).getByRole('button', { name: /^web-1/ })).queryByRole('img', { name: /^Health/ })).toBeNull();
    });

    it('stay away without fleet data', () => {
        renderSidebar();
        expect(screen.queryByRole('img', { name: /^Health/ })).toBeNull();
    });
});
