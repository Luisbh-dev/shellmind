import { holdForCode, isAlertState, type FleetAlertState, type FleetError, type FleetHold, type FleetState } from "../../shared/fleet";
import { connectionError } from "../ssh/connectionErrors";
import { HostKeyMismatchError } from "../ssh/hostKeys";
import { ProbeError } from "./probe";

// The rules of the fleet checks, as pure functions: what a failed check
// means, when the next one runs, and when a state change is an alert.

export const FLEET_TIMING = {
    // How often the scheduler looks for checks that are due.
    tickMs: 2000,
    // How often the list of saved servers is read again.
    syncMs: 10_000,
    // A first failure, or a first critical reading, is checked again this
    // soon (when the interval is longer), so an alert is confirmed quickly
    // and a single dropped packet raises none.
    confirmMs: 60_000,
    // Retries of a server that keeps failing back off up to this (or the
    // interval, if longer).
    maxBackoffMs: 60 * 60_000,
    // Each delay is spread by up to ±10%, so servers checked together drift
    // apart instead of hitting their bastion at the same moment.
    jitter: 0.1,
    // Checks that are overdue at startup (or after the computer slept) are
    // spread over this long.
    catchUpMs: 30_000,
    // A check that has not finished after this long is given up (connecting
    // and the script have their own, shorter limits).
    checkTimeoutMs: 120_000
} as const;

export function jittered(ms: number, random: () => number = Math.random): number {
    return Math.round(ms * (1 - FLEET_TIMING.jitter + 2 * FLEET_TIMING.jitter * random()));
}

// The wait before retrying a server whose last `failures` checks in a row
// failed: soon after the first (to confirm it), then the interval, doubling
// each time.
export function retryDelay(intervalMs: number, failures: number): number {
    if (failures <= 1) return Math.min(intervalMs, FLEET_TIMING.confirmMs);
    return Math.min(intervalMs * 2 ** (failures - 2), Math.max(intervalMs, FLEET_TIMING.maxBackoffMs));
}

// A login (a user name, or a saved identity) rejected on this many servers in
// a row, with no success in between, pauses the automatic checks of the other
// servers that log in with it: a directory account whose password changed is
// rejected everywhere, and one attempt per server could lock it.
export const LOGIN_BREAKER_FAILURES = 3;

// Failures that only someone can fix: retrying them would repeat a rejected
// login (an account lockout, a fail2ban ban) or keep knocking on a host that
// is not the one that was trusted.
const MAX_MESSAGE_LENGTH = 500;

export type FailureOutcome = {
    state: "unreachable" | "error";
    hold: FleetHold | null;
    error: FleetError;
    // The key that was refused, for a changed host key.
    hostKey?: { host: string; port: number; via: string; actual: string };
};

// What a failed check means. Before the server was reached it is
// unreachable, unless the failure is one only someone can fix; after, the
// check itself failed (the server is up).
export function classifyFailure(err: unknown): FailureOutcome {
    const phase = err instanceof ProbeError ? err.phase : "connect";
    const cause = err instanceof ProbeError ? err.failure : err;
    const { code, message, details } = connectionError(cause);
    const error: FleetError = { code, message: message.slice(0, MAX_MESSAGE_LENGTH), ...(details ? { details } : {}) };
    if (cause instanceof HostKeyMismatchError) {
        return { state: "error", hold: "host-key", error, hostKey: { host: cause.host, port: cause.port, via: cause.via, actual: cause.actual } };
    }
    const hold = holdForCode(code);
    if (hold === "auth" || hold === "config") return { state: "error", hold, error };
    return { state: phase === "connect" ? "unreachable" : "error", hold: null, error };
}

// The alert bookkeeping of one server.
export type AlertTrack = {
    // The state of the latest check, and how many checks in a row ended in it.
    state: FleetState | null;
    streak: number;
    // The state before the streak began.
    before: FleetState | null;
    // The alert state last raised (cleared once the server leaves it).
    alerted: FleetAlertState | null;
};

// Checks in a row that must agree before an alert is raised.
export const ALERT_CONFIRMATIONS = 2;

// The track after a check ended in `state`, and the alert it raises, if any.
export function observeState(track: AlertTrack, state: FleetState): { track: AlertTrack; alert: { state: FleetAlertState; previous: FleetState | null } | null } {
    const same = track.state === state;
    const next: AlertTrack = {
        state,
        streak: same ? track.streak + 1 : 1,
        before: same ? track.before : track.state,
        alerted: track.alerted
    };
    if (!isAlertState(state)) return { track: { ...next, alerted: null }, alert: null };
    if (next.streak >= ALERT_CONFIRMATIONS && track.alerted !== state) {
        return { track: { ...next, alerted: state }, alert: { state, previous: next.before } };
    }
    return { track: next, alert: null };
}

// The server just entered an alert state that a second check must confirm.
export function awaitsConfirmation(track: AlertTrack): boolean {
    return track.state !== null && isAlertState(track.state) && track.alerted !== track.state && track.streak < ALERT_CONFIRMATIONS;
}
