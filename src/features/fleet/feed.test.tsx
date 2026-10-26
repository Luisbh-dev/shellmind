import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLEET_SETTINGS, type FleetBoard, type FleetSnapshot } from '@shared/fleet';
import { acquireFleetFeed, markRequested, onFleetAlerts, resetFleetFeed, setFleetSocketFactory, unmarkRequested, useFleetStore } from './feed';
import { FakeFleetSocket } from './testSocket';

const snapshot = (serverId: number, overrides: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
    serverId, state: 'ok', issues: [], metrics: null, checkedAt: 1000, lastSeenAt: 1000, error: null, handshakeMs: null, durationMs: 10,
    failures: 0, hold: null, blocked: null, readAt: null, reachedVia: null, sshSeenAt: null, monitored: true, checking: false, nextCheckAt: null, ...overrides
});

const BOARD: FleetBoard = { settings: DEFAULT_FLEET_SETTINGS, snapshots: [snapshot(1), snapshot(2, { state: 'critical' })] };

let socket: FakeFleetSocket;
let created: number;

beforeEach(() => {
    resetFleetFeed();
    socket = new FakeFleetSocket(BOARD);
    created = 0;
    setFleetSocketFactory(() => {
        created += 1;
        return socket.asSocket();
    });
});

afterEach(() => {
    resetFleetFeed();
    setFleetSocketFactory(null);
    vi.useRealTimers();
});

describe('fleet feed', () => {
    it('subscribes once connected and keeps the board', () => {
        const release = acquireFleetFeed();
        expect(useFleetStore.getState().status).toBe('connecting');
        socket.connect();
        expect(socket.emitted).toEqual(['fleet-subscribe']);
        expect(useFleetStore.getState()).toMatchObject({ status: 'live', settings: DEFAULT_FLEET_SETTINGS });
        expect(Object.keys(useFleetStore.getState().snapshots)).toEqual(['1', '2']);
        release();
    });

    it('applies what changed: snapshots, removed servers, settings, and hands out alerts', () => {
        const release = acquireFleetFeed();
        socket.connect();
        const alerts = vi.fn();
        onFleetAlerts(alerts);
        socket.push({
            snapshots: [snapshot(1, { state: 'warn' })],
            removed: [2],
            settings: { ...DEFAULT_FLEET_SETTINGS, enabled: true },
            alerts: [{ serverId: 1, state: 'critical', previous: 'ok', at: 5 }]
        });
        const state = useFleetStore.getState();
        expect(state.snapshots[1].state).toBe('warn');
        expect(state.snapshots[2]).toBeUndefined();
        expect(state.settings?.enabled).toBe(true);
        expect(alerts).toHaveBeenCalledWith([{ serverId: 1, state: 'critical', previous: 'ok', at: 5 }]);
        release();
    });

    it('forgets a "Check now" once the server reports a running or a newer check', () => {
        const release = acquireFleetFeed();
        socket.connect();
        markRequested([1, 2], 50);
        expect(useFleetStore.getState().requested).toEqual({ 1: { at: 50, checkedAt: 1000 }, 2: { at: 50, checkedAt: 1000 } });

        // Another change of server 1 that is not its check keeps the request.
        socket.push({ snapshots: [snapshot(1, { monitored: false })] });
        expect(useFleetStore.getState().requested[1]).toBeDefined();
        socket.push({ snapshots: [snapshot(1, { checking: true })] });
        // Whatever the clocks say: a different latest check answers it.
        socket.push({ snapshots: [snapshot(2, { checkedAt: 900 })] });
        expect(useFleetStore.getState().requested).toEqual({});

        markRequested([1]);
        unmarkRequested([1]);
        expect(useFleetStore.getState().requested).toEqual({});
        release();
    });

    it('marks the data as last known while the backend is away, and subscribes again', () => {
        const release = acquireFleetFeed();
        socket.connect();
        socket.fire('disconnect');
        expect(useFleetStore.getState().status).toBe('offline');
        expect(useFleetStore.getState().snapshots[2].state).toBe('critical');
        socket.setBoard({ settings: DEFAULT_FLEET_SETTINGS, snapshots: [snapshot(2, { state: 'ok' })] });
        socket.connect();
        expect(useFleetStore.getState()).toMatchObject({ status: 'live' });
        expect(useFleetStore.getState().snapshots[1]).toBeUndefined();
        release();
    });

    it('shares one socket between users and closes it a moment after the last one leaves', () => {
        vi.useFakeTimers();
        const first = acquireFleetFeed();
        const second = acquireFleetFeed();
        expect(created).toBe(1);
        first();
        first();
        vi.advanceTimersByTime(5000);
        expect(socket.disconnected).toBe(false);
        second();
        // Back within the delay (a re-render): the same socket.
        const again = acquireFleetFeed();
        vi.advanceTimersByTime(5000);
        expect(socket.disconnected).toBe(false);
        again();
        vi.advanceTimersByTime(1000);
        expect(socket.disconnected).toBe(true);
        expect(useFleetStore.getState().status).toBe('idle');
    });

    it('stays off without a session', () => {
        setFleetSocketFactory(() => null);
        const release = acquireFleetFeed();
        expect(useFleetStore.getState().status).toBe('idle');
        release();
    });
});
