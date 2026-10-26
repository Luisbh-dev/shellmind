import { create } from 'zustand';
import type { ConnState } from '@/components/ui/StatusDot';

// The embedded Remote Desktop session of each server, as the rest of the app
// sees it: the header, the sidebar and the chat greeting (combineConnState),
// and the "close server" guard.
export type RdpSessionState = {
    state: ConnState;
    // Epoch ms the session was established.
    since?: number;
    desktop?: { width: number; height: number };
};

type RdpStore = {
    sessions: Record<number, RdpSessionState>;
    setSession: (serverId: number, session: RdpSessionState) => void;
    clearSession: (serverId: number) => void;
};

export const useRdpStore = create<RdpStore>()((set) => ({
    sessions: {},
    setSession: (serverId, session) => set((state) => ({ sessions: { ...state.sessions, [serverId]: session } })),
    clearSession: (serverId) => set((state) => {
        if (!(serverId in state.sessions)) return state;
        const sessions = { ...state.sessions };
        delete sessions[serverId];
        return { sessions };
    })
}));

// A server's state as the app shows it: its terminal's (useAppStore
// connections), unless its Remote Desktop session is further along. A
// Windows server reached only over RDP is connected while its desktop is on
// screen, not "Error" because it has no SSH. Without a desktop session it is
// the terminal's state, unchanged.
export function combineConnState(terminal: ConnState | undefined, desktop: ConnState | undefined): ConnState | undefined {
    if (desktop === undefined) return terminal;
    if (terminal === 'connected' || desktop === 'connected') return 'connected';
    if (terminal === 'connecting' || desktop === 'connecting') return 'connecting';
    if (terminal === 'error' || desktop === 'error') return 'error';
    return terminal ?? desktop;
}

// The state of the server's Remote Desktop session, if it has one.
export function useRdpSessionState(serverId: number | null | undefined): ConnState | undefined {
    return useRdpStore((state) => (serverId == null ? undefined : state.sessions[serverId]?.state));
}
