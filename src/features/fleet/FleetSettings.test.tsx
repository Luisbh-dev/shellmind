import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FLEET_SETTINGS, type FleetSettings as Settings } from '@shared/fleet';
import { setLanguage } from '@/i18n';
import { ToastProvider } from '@/components/ui/Toast';
import { applyBoard, resetFleetFeed, useFleetStore } from './feed';
import { FleetSettings } from './FleetSettings';

let saved: Settings;
let puts: unknown[];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    setLanguage('en');
    resetFleetFeed();
    saved = { ...DEFAULT_FLEET_SETTINGS, excludedServerIds: [4, 9] };
    puts = [];
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(async () => 'granted') });
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body));
            puts.push(body);
            saved = { ...saved, ...body };
        }
        return String(input).endsWith('/api/fleet/settings') ? json({ message: 'success', data: saved }) : json({}, 404);
    }));
});

afterEach(() => {
    resetFleetFeed();
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('fleet settings', () => {
    it('reads the saved settings and saves each change', async () => {
        const user = userEvent.setup();
        render(<ToastProvider><FleetSettings /></ToastProvider>);
        const health = 'Check their health in the background (logs in)';
        const reach = 'Check that servers answer, without logging in';
        const enabled = await screen.findByRole('checkbox', { name: health });
        expect(enabled).not.toBeChecked();
        expect(screen.getByRole('checkbox', { name: reach })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Notify me when a server turns critical or unreachable' })).toBeChecked();
        expect(screen.getByText('2 servers are left out of automatic checks.')).toBeInTheDocument();

        await user.click(screen.getByRole('checkbox', { name: reach }));
        expect(puts).toEqual([{ reachability: false }]);
        await user.click(await screen.findByRole('checkbox', { name: reach }));
        expect(puts.at(-1)).toEqual({ reachability: true });

        await user.click(enabled);
        expect(puts.at(-1)).toEqual({ enabled: true });
        expect(await screen.findByRole('checkbox', { name: health })).toBeChecked();
        // Health checks tell whether a server answers too.
        expect(screen.getByRole('checkbox', { name: reach })).toBeDisabled();
        expect(screen.getByRole('checkbox', { name: reach })).toHaveAccessibleDescription('Health checks already tell whether each server answers.');

        await user.click(screen.getByRole('combobox', { name: 'Check every 5 min' }));
        await user.click(screen.getByRole('option', { name: '1 hour' }));
        expect(puts.at(-1)).toEqual({ intervalMinutes: 60 });

        await user.click(screen.getByRole('button', { name: 'Include them again' }));
        expect(puts.at(-1)).toEqual({ excludedServerIds: [] });
        expect(useFleetStore.getState().settings?.excludedServerIds).toEqual([]);
    });

    it('counts the servers left out among those on the board', async () => {
        // Server 9 is no longer on the board (the backend prunes it soon).
        applyBoard({ settings: saved, snapshots: [4, 5].map((serverId) => ({
            serverId, state: 'ok', issues: [], metrics: null, checkedAt: null, lastSeenAt: null, reachedVia: null, sshSeenAt: null, readAt: null, error: null, handshakeMs: null,
            durationMs: null, failures: 0, hold: null, blocked: null, monitored: serverId !== 4, checking: false, nextCheckAt: null
        })) });
        render(<ToastProvider><FleetSettings /></ToastProvider>);
        expect(await screen.findByText('1 server is left out of automatic checks.')).toBeInTheDocument();
    });

    it('says when the browser blocks notifications', async () => {
        vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn(async () => 'denied') });
        render(<ToastProvider><FleetSettings /></ToastProvider>);
        expect(await screen.findByText('Notifications are blocked for this page in the browser settings.')).toBeInTheDocument();
    });
});
