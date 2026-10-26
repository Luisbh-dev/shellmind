// Fleet alerts (a server confirmed critical or unreachable) for the person in
// front of the screen: a desktop notification while ShellMind is in the
// background, a toast while it is in front. Each server alerts at most once
// per ALERT_COOLDOWN_MS, and a burst (a network outage) becomes one
// notification. Clicking a notification shows that server's status.
import { useEffect, useRef } from 'react';
import type { FleetAlert } from '@shared/fleet';
import { getLanguage, t } from '@/i18n';
import { createLogger } from '@/lib/logger';
import { useAppStore } from '@/store/appStore';
import { useServersStore } from '@/store/servers';
import { onFleetAlerts, useFleetStore } from './feed';
import { namesOf, stateReason } from './model';

const log = createLogger('fleet');

export const ALERT_COOLDOWN_MS = 30 * 60_000;
// More alerts at once than this become a single notification.
export const BURST_LIMIT = 3;
export const FLEET_ACTION_ID = 'fleet';

export type AlertSink = {
    toast: (title: string, description?: string) => void;
};

export type NotificationSupport = 'unsupported' | NotificationPermission;

export function notificationSupport(): NotificationSupport {
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported';
    return window.Notification.permission;
}

// Asks once (the browser remembers the answer); call from a click.
export async function requestNotificationPermission(): Promise<NotificationSupport> {
    if (notificationSupport() !== 'default') return notificationSupport();
    try {
        return await window.Notification.requestPermission();
    } catch (err) {
        log.warn('Could not ask for the notification permission', err);
        return notificationSupport();
    }
}

const lastAlerted = new Map<number, number>();

// The alerts still to deliver after the per-server cooldown.
export function throttleAlerts(alerts: FleetAlert[], now = Date.now()): FleetAlert[] {
    const fresh: FleetAlert[] = [];
    for (const alert of alerts) {
        const last = lastAlerted.get(alert.serverId);
        if (last !== undefined && now - last < ALERT_COOLDOWN_MS) continue;
        lastAlerted.set(alert.serverId, now);
        fresh.push(alert);
    }
    return fresh;
}

export function resetAlertThrottle(): void {
    lastAlerted.clear();
}

type Message = { title: string; body: string; serverId: number | null };

function messages(alerts: FleetAlert[]): Message[] {
    const names = namesOf(useServersStore.getState().servers);
    const snapshots = useFleetStore.getState().snapshots;
    const nameOf = (id: number) => names(id) ?? `#${id}`;
    if (alerts.length > BURST_LIMIT) {
        const named = alerts.map((alert) => nameOf(alert.serverId));
        return [{ title: t('fleet.alerts.many', { count: alerts.length }), body: named.slice(0, 8).join(', ') + (named.length > 8 ? '…' : ''), serverId: null }];
    }
    return alerts.map((alert) => {
        const snapshot = snapshots[alert.serverId] ?? null;
        const reason = stateReason(t, getLanguage(), snapshot, 3, names);
        const body = alert.state === 'unreachable' && reason ? t('fleet.alerts.reasonUnreachable', { reason }) : reason;
        return { title: t(`fleet.alerts.${alert.state}`, { name: nameOf(alert.serverId) }), body, serverId: alert.serverId };
    });
}

function showDesktop(message: Message): boolean {
    try {
        const notification = new window.Notification(message.title, {
            body: message.body,
            tag: message.serverId === null ? 'shellmind-fleet' : `shellmind-fleet-${message.serverId}`
        });
        notification.onclick = () => {
            window.focus();
            const store = useAppStore.getState();
            if (message.serverId === null) {
                store.openAction(FLEET_ACTION_ID);
            } else {
                // The server's status, not the board in front of it.
                if (store.activeActionId === FLEET_ACTION_ID) store.closeAction();
                store.requestServerTab(message.serverId, 'status');
            }
            notification.close();
        };
        return true;
    } catch (err) {
        // Some browsers only create notifications from a service worker.
        log.warn('Could not show a desktop notification', err);
        return false;
    }
}

export function deliverAlerts(alerts: FleetAlert[], sink: AlertSink, now = Date.now()): void {
    if (!useFleetStore.getState().settings?.notifications) return;
    const fresh = throttleAlerts(alerts, now);
    if (!fresh.length) return;
    const inFront = typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
    const desktop = !inFront && notificationSupport() === 'granted';
    // The open fleet board shows the change itself: a toast would only
    // cover its filters.
    const boardOpen = useAppStore.getState().activeActionId === FLEET_ACTION_ID;
    for (const message of messages(fresh)) {
        if (desktop && showDesktop(message)) continue;
        if (boardOpen) continue;
        sink.toast(message.title, message.body || undefined);
    }
}

// Delivers the alerts of the feed while the calling component is mounted.
export function useFleetAlerts(sink: AlertSink): void {
    const sinkRef = useRef(sink);
    useEffect(() => {
        sinkRef.current = sink;
    });
    useEffect(() => onFleetAlerts((alerts) => deliverAlerts(alerts, sinkRef.current)), []);
}
