import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLEET_SETTINGS, type FleetAlert, type FleetSnapshot } from '@shared/fleet';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { resetServersStore, useServersStore } from '@/store/servers';
import { applyBoard, resetFleetFeed } from './feed';
import { ALERT_COOLDOWN_MS, deliverAlerts, FLEET_ACTION_ID, resetAlertThrottle } from './notifications';

type Recorded = { title: string; options?: NotificationOptions; onclick: (() => void) | null; close: () => void };

const created: Recorded[] = [];
let permission: NotificationPermission = 'granted';

class FakeNotification {
    title: string;
    options?: NotificationOptions;
    onclick: (() => void) | null = null;
    closed = false;

    constructor(title: string, options?: NotificationOptions) {
        this.title = title;
        this.options = options;
        created.push(this);
    }

    close() {
        this.closed = true;
    }

    static get permission() {
        return permission;
    }
}

const snapshot = (serverId: number, overrides: Partial<FleetSnapshot>): FleetSnapshot => ({
    serverId, state: 'critical', issues: [], metrics: null, checkedAt: 1, lastSeenAt: 1, error: null, handshakeMs: null, durationMs: 1,
    failures: 0, hold: null, blocked: null, readAt: null, reachedVia: null, sshSeenAt: null, monitored: true, checking: false, nextCheckAt: null, ...overrides
});

const alert = (serverId: number, state: FleetAlert['state'] = 'critical'): FleetAlert => ({ serverId, state, previous: 'ok', at: 1 });

function setFocus(inFront: boolean) {
    vi.spyOn(document, 'hasFocus').mockReturnValue(inFront);
}

beforeEach(() => {
    setLanguage('en');
    created.length = 0;
    permission = 'granted';
    resetAlertThrottle();
    resetFleetFeed();
    resetServersStore();
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.stubGlobal('Notification', FakeNotification);
    useServersStore.setState({ status: 'ready', servers: [1, 2, 3, 4, 5].map((id) => ({ id, name: `srv-${id}`, ip: `10.0.0.${id}`, type: 'linux' as const })) });
    applyBoard({
        settings: DEFAULT_FLEET_SETTINGS,
        snapshots: [
            snapshot(1, { issues: [{ metric: 'disk', tone: 'critical', value: 97, mount: '/var' }] }),
            snapshot(2, { state: 'unreachable', error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } })
        ]
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLanguage('system');
});

describe('fleet alerts', () => {
    it('become desktop notifications while ShellMind is in the background', () => {
        setFocus(false);
        const toast = vi.fn();
        deliverAlerts([alert(1), alert(2, 'unreachable')], { toast }, 0);
        expect(toast).not.toHaveBeenCalled();
        expect(created.map((note) => [note.title, note.options?.body, note.options?.tag])).toEqual([
            ['srv-1 is critical', '/var 97% full', 'shellmind-fleet-1'],
            ['srv-2 is unreachable', 'No SSH connection: The server refused the connection: nothing listens on that port.', 'shellmind-fleet-2']
        ]);
    });

    it('open the server\'s status when clicked, in front of the fleet board', () => {
        setFocus(false);
        vi.spyOn(window, 'focus').mockImplementation(() => undefined);
        useAppStore.getState().openAction(FLEET_ACTION_ID);
        deliverAlerts([alert(1)], { toast: vi.fn() }, 0);
        created[0].onclick?.();
        expect(window.focus).toHaveBeenCalled();
        expect(useAppStore.getState()).toMatchObject({ activeActionId: null, serverTabRequest: { serverId: 1, tabId: 'status' } });
    });

    it('are toasts while ShellMind is in front, or when notifications are not allowed', () => {
        setFocus(true);
        const toast = vi.fn();
        deliverAlerts([alert(1)], { toast }, 0);
        expect(toast).toHaveBeenCalledWith('srv-1 is critical', '/var 97% full');
        expect(created).toEqual([]);

        setFocus(false);
        permission = 'denied';
        deliverAlerts([alert(2, 'unreachable')], { toast }, 0);
        expect(toast).toHaveBeenCalledTimes(2);
        expect(created).toEqual([]);
    });

    // UX-10: the toast covered the open board's filters; the board shows the
    // change itself. A desktop notification still comes in the background.
    it('raise no toast while the fleet board is open', () => {
        setFocus(true);
        const toast = vi.fn();
        useAppStore.getState().openAction(FLEET_ACTION_ID);
        try {
            deliverAlerts([alert(1)], { toast }, 0);
            expect(toast).not.toHaveBeenCalled();
            setFocus(false);
            deliverAlerts([alert(2, 'unreachable')], { toast }, 0);
            expect(created.map((note) => note.title)).toEqual(['srv-2 is unreachable']);
        } finally {
            useAppStore.getState().closeAction();
        }
    });

    it('come once per server per half hour', () => {
        setFocus(true);
        const toast = vi.fn();
        deliverAlerts([alert(1)], { toast }, 0);
        deliverAlerts([alert(1)], { toast }, ALERT_COOLDOWN_MS - 1);
        expect(toast).toHaveBeenCalledTimes(1);
        deliverAlerts([alert(1)], { toast }, ALERT_COOLDOWN_MS);
        expect(toast).toHaveBeenCalledTimes(2);
    });

    it('in a burst become one notification that opens the board', () => {
        setFocus(false);
        deliverAlerts([alert(1), alert(2), alert(3), alert(4)], { toast: vi.fn() }, 0);
        expect(created).toHaveLength(1);
        expect(created[0].title).toBe('4 servers need attention');
        expect(created[0].options?.body).toBe('srv-1, srv-2, srv-3, srv-4');
        created[0].onclick?.();
        expect(useAppStore.getState().activeActionId).toBe(FLEET_ACTION_ID);
    });

    it('stay quiet when they are turned off', () => {
        setFocus(true);
        applyBoard({ settings: { ...DEFAULT_FLEET_SETTINGS, notifications: false }, snapshots: [] });
        const toast = vi.fn();
        deliverAlerts([alert(1)], { toast }, 0);
        expect(toast).not.toHaveBeenCalled();
        expect(created).toEqual([]);
    });
});
