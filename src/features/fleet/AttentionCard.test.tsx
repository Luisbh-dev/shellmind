import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FLEET_SETTINGS, type FleetSnapshot } from '@shared/fleet';
import type { ServerSummary } from '@shared/types';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { AttentionCard } from './AttentionCard';
import { applyBoard, resetFleetFeed } from './feed';

const NOW = 1_800_000_000_000;
const SERVERS: ServerSummary[] = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, name: `srv-${index + 1}`, ip: `10.0.0.${index + 1}`, type: 'linux' }));

const snapshot = (serverId: number, overrides: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
    serverId, state: 'ok', issues: [], metrics: null, checkedAt: NOW - 120_000, lastSeenAt: NOW - 120_000, error: null, handshakeMs: null,
    durationMs: 1, failures: 0, hold: null, blocked: null, readAt: null, reachedVia: null, sshSeenAt: null, monitored: true, checking: false, nextCheckAt: null, ...overrides
});

beforeEach(() => {
    setLanguage('en');
    resetFleetFeed();
    useAppStore.setState(useAppStore.getInitialState(), true);
});

afterEach(() => {
    resetFleetFeed();
    setLanguage('system');
});

describe('welcome attention card', () => {
    it('stays away until the fleet is known', () => {
        const { container } = render(<AttentionCard servers={SERVERS} now={NOW} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('invites to set the checks up before any server was checked', async () => {
        applyBoard({ settings: DEFAULT_FLEET_SETTINGS, snapshots: SERVERS.map((server) => snapshot(server.id, { state: 'unknown', checkedAt: null, lastSeenAt: null })) });
        render(<AttentionCard servers={SERVERS} now={NOW} />);
        await userEvent.click(screen.getByRole('button', { name: /Fleet health/ }));
        expect(useAppStore.getState().activeActionId).toBe('fleet');
    });

    it('says when every checked server is healthy', () => {
        applyBoard({ settings: DEFAULT_FLEET_SETTINGS, snapshots: [snapshot(1), snapshot(2)] });
        render(<AttentionCard servers={SERVERS} now={NOW} />);
        expect(screen.getByRole('heading', { name: 'All 2 checked servers are healthy' })).toBeInTheDocument();
    });

    it('lists the servers that need attention, most urgent first, and opens one', async () => {
        applyBoard({
            settings: DEFAULT_FLEET_SETTINGS,
            snapshots: [
                snapshot(1, { state: 'warn', issues: [{ metric: 'memory', tone: 'warn', value: 85 }] }),
                snapshot(2, { state: 'critical', issues: [{ metric: 'disk', tone: 'critical', value: 97, mount: '/' }] }),
                snapshot(3, { state: 'unreachable', error: { code: 'ETIMEDOUT', message: 'timed out' } }),
                snapshot(4, { state: 'warn' }), snapshot(5, { state: 'warn' }), snapshot(6, { state: 'warn' }), snapshot(7, { state: 'warn' }),
                snapshot(8)
            ]
        });
        render(<AttentionCard servers={SERVERS} now={NOW} />);
        expect(screen.getByRole('heading', { name: 'Needs attention 7' })).toBeInTheDocument();
        const items = screen.getAllByRole('listitem');
        expect(items[0]).toHaveTextContent('srv-2Critical/ 97% full');
        expect(items[1]).toHaveTextContent('srv-3UnreachableThe connection timed out.');
        expect(items[0]).toHaveTextContent('Checked 2 min ago');
        expect(screen.getByRole('button', { name: '+2 more' })).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: /srv-2/ }));
        expect(useAppStore.getState().serverTabRequest).toMatchObject({ serverId: 2, tabId: 'status' });
    });

    it('opens the board, not the server, when the server\'s login was just rejected', async () => {
        applyBoard({
            settings: DEFAULT_FLEET_SETTINGS,
            snapshots: [snapshot(1, { state: 'error', hold: 'auth', error: { code: 'AUTH_FAILED', message: 'Auth failed' } })]
        });
        render(<AttentionCard servers={SERVERS} now={NOW} />);
        await userEvent.click(screen.getByRole('button', { name: /srv-1/ }));
        expect(useAppStore.getState().serverTabRequest).toBeNull();
        expect(useAppStore.getState().activeActionId).toBe('fleet');
    });
});
