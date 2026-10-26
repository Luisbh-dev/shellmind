// The fleet board's live data: one socket subscribed to "fleet-health" while
// any part of the UI needs it (the sidebar dots keep it on for the whole
// session), and a store the board, the sidebar and the welcome screen read.
// The backend answers the subscription with the whole board, so a
// reconnection starts from a complete picture again.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { FleetAlert, FleetBoard, FleetHealthEvent, FleetSettings, FleetSnapshot } from '@shared/fleet';
import { getAuthToken } from '@/lib/api';
import { createSocket, type AppSocket } from '@/lib/socket';

// idle: no feed (nobody asked, or no session yet); connecting: waiting for
// the first board; live: up to date; offline: the backend went away (the
// data shown is the last known).
export type FleetFeedStatus = 'idle' | 'connecting' | 'live' | 'offline';

// A "Check now" the backend has not reported on yet: when it was asked (this
// computer's clock) and the server's latest check at that moment.
export type CheckRequest = { at: number; checkedAt: number | null };

type FleetStoreState = {
    status: FleetFeedStatus;
    // null until the first board arrived.
    settings: FleetSettings | null;
    snapshots: Record<number, FleetSnapshot>;
    // Checks asked for, by server id, so the row shows the check at once.
    requested: Record<number, CheckRequest>;
};

const initialState = (): FleetStoreState => ({ status: 'idle', settings: null, snapshots: {}, requested: {} });

export const useFleetStore = create<FleetStoreState>()(initialState);

// A request the backend has not reported within this long is forgotten.
export const REQUEST_PENDING_MS = 2 * 60_000;

export function applyBoard(board: FleetBoard): void {
    useFleetStore.setState((state) => ({
        status: 'live',
        settings: board.settings,
        snapshots: Object.fromEntries(board.snapshots.map((snapshot) => [snapshot.serverId, snapshot])),
        requested: pruneRequested(state.requested, board.snapshots)
    }));
}

// A request is answered once its server reports a running check, or a check
// newer than the one it had (whichever clock the backend keeps), or that its
// checks wait for another server (the backend does not run it then).
function pruneRequested(requested: Record<number, CheckRequest>, snapshots: FleetSnapshot[]): Record<number, CheckRequest> {
    let next = requested;
    for (const snapshot of snapshots) {
        const request = next[snapshot.serverId];
        const waits = snapshot.blocked?.kind === 'jump-host';
        if (!request || !(snapshot.checking || snapshot.checkedAt !== request.checkedAt || waits)) continue;
        if (next === requested) next = { ...requested };
        delete next[snapshot.serverId];
    }
    return next;
}

const alertListeners = new Set<(alerts: FleetAlert[]) => void>();

export function onFleetAlerts(listener: (alerts: FleetAlert[]) => void): () => void {
    alertListeners.add(listener);
    return () => {
        alertListeners.delete(listener);
    };
}

export function applyEvent(event: FleetHealthEvent): void {
    useFleetStore.setState((state) => {
        const snapshots = { ...state.snapshots };
        for (const snapshot of event.snapshots ?? []) snapshots[snapshot.serverId] = snapshot;
        let requested = pruneRequested(state.requested, event.snapshots ?? []);
        for (const id of event.removed ?? []) {
            delete snapshots[id];
            if (requested[id] !== undefined) {
                requested = { ...requested };
                delete requested[id];
            }
        }
        return { snapshots, requested, settings: event.settings ?? state.settings };
    });
    if (event.alerts?.length) {
        for (const listener of [...alertListeners]) listener(event.alerts);
    }
}

// Marks checks as asked for. Call it before sending the request: a check
// can finish (and be reported) before the request's answer arrives.
export function markRequested(ids: number[], at = Date.now()): void {
    if (!ids.length) return;
    useFleetStore.setState((state) => ({
        requested: {
            ...state.requested,
            ...Object.fromEntries(ids.map((id): [number, CheckRequest] => [id, { at, checkedAt: state.snapshots[id]?.checkedAt ?? null }]))
        }
    }));
}

// Forgets requests the backend did not take (skipped, or the request failed).
export function unmarkRequested(ids: number[]): void {
    if (!ids.length) return;
    useFleetStore.setState((state) => {
        const requested = { ...state.requested };
        for (const id of ids) delete requested[id];
        return { requested };
    });
}

export function setFleetSettings(settings: FleetSettings): void {
    useFleetStore.setState({ settings });
}

// --- the socket ---------------------------------------------------------------

type SocketFactory = () => AppSocket | null;

// Without a session there is nothing to subscribe with (the access screen
// is showing, or a test renders a component on its own).
const defaultFactory: SocketFactory = () => (getAuthToken() ? createSocket() : null);

let factory: SocketFactory = defaultFactory;
let socket: AppSocket | null = null;
let refs = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

// Unmounting and mounting again right away (a re-render, StrictMode) keeps
// the same socket.
const CLOSE_DELAY_MS = 1000;

function open(): void {
    if (socket) return;
    const created = factory();
    if (!created) return;
    socket = created;
    useFleetStore.setState({ status: 'connecting' });
    created.on('connect', () => {
        created.emit('fleet-subscribe', (board) => {
            if (socket === created) applyBoard(board);
        });
    });
    created.on('disconnect', () => {
        if (socket === created) useFleetStore.setState({ status: 'offline' });
    });
    created.on('connect_error', () => {
        if (socket === created && useFleetStore.getState().status !== 'connecting') useFleetStore.setState({ status: 'offline' });
    });
    created.on('fleet-health', (event) => {
        if (socket === created) applyEvent(event);
    });
}

function close(): void {
    const current = socket;
    socket = null;
    current?.disconnect();
    if (useFleetStore.getState().status !== 'idle') useFleetStore.setState({ status: 'idle' });
}

// Keeps the feed on until the returned function is called.
export function acquireFleetFeed(): () => void {
    refs += 1;
    if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
    }
    open();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        refs -= 1;
        if (refs > 0) return;
        closeTimer = setTimeout(() => {
            closeTimer = null;
            if (refs === 0) close();
        }, CLOSE_DELAY_MS);
    };
}

// The feed, while the calling component is mounted.
export function useFleetFeed(): void {
    useEffect(() => acquireFleetFeed(), []);
}

// Tests: where sockets come from (null: the default), and a clean slate.
export function setFleetSocketFactory(next: SocketFactory | null): void {
    factory = next ?? defaultFactory;
}

export function resetFleetFeed(): void {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    refs = 0;
    close();
    alertListeners.clear();
    useFleetStore.setState(initialState(), true);
}
