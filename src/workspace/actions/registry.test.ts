import { describe, expect, it, vi } from 'vitest';
import { Command, KeyRound, Network } from 'lucide-react';
import type { WorkspaceServer } from '../types';
import { actionRegistry, createActionRegistry, formatShortcut, matchesShortcut } from './registry';
import type { GlobalAction } from './types';

const Noop = () => null;

const action = (overrides: Partial<GlobalAction> & Pick<GlobalAction, 'id' | 'order'>): GlobalAction => ({
    labelKey: `actions.${overrides.id}`,
    icon: Command,
    placement: 'header',
    Component: Noop,
    ...overrides,
});

const linux: WorkspaceServer = { id: 1, name: 'web', ip: '10.0.0.1', type: 'linux' };
const bucket: WorkspaceServer = { id: 2, name: 'bucket', ip: '', type: 's3' };

const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
    key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods,
});

describe('global action registry', () => {
    it('registers the actions of the feature slices (files in src/workspace/actions)', () => {
        // W7-S1: 'fleet' (order 20, header, Mod+Shift+H); W7-S4: 'multiexec-jobs' (order 41, palette); W7-S5: 'triage' (order 70, palette).
        // W8-T4: 'disk' (order 75, palette).
        // W8-T3: 'patch-center' (order 25, header), 'patch-server' (order 26, palette).
        // W8-T2: 'kubernetes' (order 76, palette; its background looks for kubectl on connected Linux servers).
        expect(actionRegistry.actions.map((a) => a.id)).toEqual(['fleet', 'patch-center', 'patch-server', 'snippets', 'multiexec', 'multiexec-jobs', 'triage', 'disk', 'kubernetes', 'audit', 'known-hosts', 'terminal-new-tab', 'terminal-close-tab', 'terminal-split-right', 'terminal-split-down', 'terminal-next-pane', 'terminal-broadcast']);
        expect(actionRegistry.header(null).map((a) => a.id)).toEqual(['fleet', 'patch-center', 'snippets', 'multiexec']);
        expect(actionRegistry.get('audit')?.placement).toBe('palette');
        // W7-S4: the job list from the palette; finished jobs notify from the background.
        expect(actionRegistry.get('multiexec-jobs')).toMatchObject({ placement: 'palette', labelKey: 'multiexec.jobsAction' });
        expect(actionRegistry.backgrounds.map((entry) => entry.id)).toEqual(['multiexec', 'kubernetes']);
        expect(actionRegistry.get('kubernetes')).toMatchObject({ placement: 'palette', requiresServer: true, labelKey: 'k8s.lookForKubectl' });
        expect(actionRegistry.available(linux).map((a) => a.id)).toContain('kubernetes');
        expect(actionRegistry.available(bucket).map((a) => a.id)).not.toContain('kubernetes');
        expect(actionRegistry.get('known-hosts')).toMatchObject({ placement: 'palette', labelKey: 'knownHosts.action' });
        expect(actionRegistry.get('fleet')).toMatchObject({ placement: 'header', labelKey: 'fleet.title' });
        const shortcuts = Object.fromEntries(actionRegistry.actions.map((a) => [a.id, a.shortcut]));
        expect(shortcuts).toEqual({ fleet: 'Mod+Shift+H', snippets: 'Mod+Shift+S', multiexec: 'Mod+Shift+E', audit: 'Mod+Shift+L' });
    });

    // W7-S5: the triage pack, from the palette, for SSH-capable servers.
    it('offers the triage pack for SSH-capable servers only', () => {
        expect(actionRegistry.get('triage')).toMatchObject({ placement: 'palette', requiresServer: true, labelKey: 'chat.diagnose.triageAction' });
        expect(actionRegistry.available(linux).map((a) => a.id)).toContain('triage');
        expect(actionRegistry.available(bucket).map((a) => a.id)).not.toContain('triage');
        expect(actionRegistry.available(null).map((a) => a.id)).not.toContain('triage');
    });

    // W8-T4: the disk toolkit, from the palette, for SSH-capable servers.
    it('offers the disk toolkit for SSH-capable servers only', () => {
        expect(actionRegistry.get('disk')).toMatchObject({ placement: 'palette', requiresServer: true, labelKey: 'disk.action' });
        expect(actionRegistry.available(linux).map((a) => a.id)).toContain('disk');
        expect(actionRegistry.available(bucket).map((a) => a.id)).not.toContain('disk');
        expect(actionRegistry.available(null).map((a) => a.id)).not.toContain('disk');
    });

    it('binds the terminal tab actions to Mod+Shift+T and Mod+Shift+W in the desktop app', () => {
        const ctrlShift = (k: string) => key(k, { ctrlKey: true, shiftKey: true });
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/138.0 Electron/38.0.0 Safari/537.36' });
        try {
            expect(actionRegistry.forShortcut(ctrlShift('T'), linux)?.id).toBe('terminal-new-tab');
            expect(actionRegistry.forShortcut(ctrlShift('T'), bucket)).toBeUndefined();
            expect(actionRegistry.forShortcut(ctrlShift('T'), null)).toBeUndefined();
            expect(actionRegistry.get('terminal-close-tab')?.shortcut).toBe('Mod+Shift+W');
            // Closing needs the server's terminal on screen (see TerminalPanel).
            expect(actionRegistry.forShortcut(ctrlShift('W'), linux)).toBeUndefined();
            expect(actionRegistry.header(linux).map((a) => a.id)).toEqual(['fleet', 'patch-center', 'snippets', 'multiexec']);
        } finally {
            vi.unstubAllGlobals();
        }
        // A browser keeps these shortcuts for its own tabs.
        expect(actionRegistry.forShortcut(ctrlShift('T'), linux)).toBeUndefined();
        expect(actionRegistry.get('terminal-close-tab')?.shortcut).toBeUndefined();
    });

    // UX-09: panes and broadcast input were reachable only by their keys
    // (taken by GNOME on Linux) and the mouse.
    it('offers the terminal pane commands in the palette while the terminal is on screen, found in both languages', async () => {
        const { useAppStore } = await import('@/store/appStore');
        const { rankItems } = await import('@/features/palette/items');
        const ids = ['terminal-split-right', 'terminal-split-down', 'terminal-next-pane', 'terminal-broadcast'];
        for (const id of ids) expect(actionRegistry.get(id)).toMatchObject({ placement: 'palette', requiresServer: true });
        expect(actionRegistry.available(linux).map((a) => a.id)).not.toEqual(expect.arrayContaining(['terminal-split-right']));
        useAppStore.setState({
            visibleTerminalServer: linux.id,
            terminalSessions: { ...useAppStore.getState().terminalSessions, [linux.id]: { sessions: [{ id: 's1', title: null, createdAt: 1 }], focusedId: 's1' } } as never
        });
        try {
            expect(actionRegistry.available(linux).map((a) => a.id)).toEqual(expect.arrayContaining(ids));
            const items = actionRegistry.available(linux).map((a) => ({ id: a.id, section: 'actions' as const, label: a.id, keywords: a.keywords, icon: a.icon, run: () => undefined }));
            for (const [query, id] of [['dividir', 'terminal-split-right'], ['split', 'terminal-split-down'], ['simultánea', 'terminal-broadcast'], ['broadcast', 'terminal-broadcast'], ['panel siguiente', 'terminal-next-pane']] as const) {
                expect(rankItems(items, query).map((ranked) => ranked.item.id), query).toContain(id);
            }
        } finally {
            useAppStore.setState({ visibleTerminalServer: null, paneCommand: null });
        }
    });

    // --- W8-T3 patch center ---
    it('offers the patch center in the header, with or without a server', () => {
        expect(actionRegistry.get('patch-center')).toMatchObject({ placement: 'header', labelKey: 'patch.action', order: 25 });
        expect(actionRegistry.get('patch-center')?.shortcut).toBeUndefined();
        expect(actionRegistry.available(bucket).map((a) => a.id)).toContain('patch-center');
        // The active server's updates, from the palette, for SSH servers only.
        expect(actionRegistry.get('patch-server')).toMatchObject({ placement: 'palette', requiresServer: true, labelKey: 'patch.serverAction' });
        expect(actionRegistry.available(linux).map((a) => a.id)).toContain('patch-server');
        expect(actionRegistry.available(bucket).map((a) => a.id)).not.toContain('patch-server');
        expect(actionRegistry.available(null).map((a) => a.id)).not.toContain('patch-server');
    });
    // --- end W8-T3 ---

    it('orders actions and filters them by placement and availability', () => {
        const registry = createActionRegistry([
            action({ id: 'tunnels', order: 30, icon: Network, requiresServer: true, isAvailable: (s) => s?.type !== 's3' }),
            action({ id: 'palette', order: 10, placement: 'palette', shortcut: 'Mod+K' }),
            action({ id: 'vault', order: 20, icon: KeyRound }),
        ]);

        expect(registry.actions.map((a) => a.id)).toEqual(['palette', 'vault', 'tunnels']);
        expect(registry.get('vault')?.icon).toBe(KeyRound);
        expect(registry.get('nope')).toBeUndefined();

        expect(registry.header(null).map((a) => a.id)).toEqual(['vault']);
        expect(registry.header(linux).map((a) => a.id)).toEqual(['vault', 'tunnels']);
        expect(registry.header(bucket).map((a) => a.id)).toEqual(['vault']);
        expect(registry.available(null).map((a) => a.id)).toEqual(['palette', 'vault']);
    });

    it('finds the available action bound to a shortcut', () => {
        const registry = createActionRegistry([
            action({ id: 'palette', order: 10, placement: 'palette', shortcut: 'Ctrl+K' }),
            action({ id: 'tunnels', order: 20, shortcut: 'Ctrl+Shift+T', requiresServer: true }),
        ]);
        const ctrlShiftT = key('T', { ctrlKey: true, shiftKey: true });

        expect(registry.forShortcut(key('k', { ctrlKey: true }), null)?.id).toBe('palette');
        expect(registry.forShortcut(ctrlShiftT, null)).toBeUndefined();
        expect(registry.forShortcut(ctrlShiftT, linux)?.id).toBe('tunnels');
        expect(registry.forShortcut(key('a', { ctrlKey: true }), linux)).toBeUndefined();
    });

    it('rejects duplicate ids', () => {
        expect(() => createActionRegistry([action({ id: 'x', order: 1 }), action({ id: 'x', order: 2 })]))
            .toThrow('Duplicate global action id "x"');
    });
});

describe('shortcuts', () => {
    it('maps Mod to Ctrl, or to Cmd on macOS, and requires the exact modifiers', () => {
        expect(matchesShortcut(key('k', { ctrlKey: true }), 'Mod+K', false)).toBe(true);
        expect(matchesShortcut(key('K', { ctrlKey: true }), 'Mod+K', false)).toBe(true);
        expect(matchesShortcut(key('k', { metaKey: true }), 'Mod+K', false)).toBe(false);
        expect(matchesShortcut(key('k', { metaKey: true }), 'Mod+K', true)).toBe(true);
        expect(matchesShortcut(key('k', { ctrlKey: true, shiftKey: true }), 'Mod+K', false)).toBe(false);
        expect(matchesShortcut(key('p', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+P', false)).toBe(true);
        expect(matchesShortcut(key('k'), 'K', false)).toBe(true);
        expect(matchesShortcut(key('k'), '', false)).toBe(false);
    });

    it('formats shortcuts for each platform', () => {
        expect(formatShortcut('Mod+K', false)).toBe('Ctrl+K');
        expect(formatShortcut('Mod+Shift+p', false)).toBe('Ctrl+Shift+P');
        expect(formatShortcut('Mod+Shift+P', true)).toBe('⇧⌘P');
        expect(formatShortcut('Alt+Enter', false)).toBe('Alt+Enter');
    });
});
