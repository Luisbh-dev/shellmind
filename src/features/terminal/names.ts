// How a terminal tab of any open server is named in the broadcast dialogs:
// "web-1 · Terminal 2"; and what a destructive command does, in the words
// the AI chat uses for it.
import type { DangerReason } from '@shared/commandSafety';
import type { TranslateFn } from '@/i18n';
import { useAppStore, type TerminalSessionInfo } from '@/store/appStore';
import { useServersStore } from '@/store/servers';
import { parseBroadcastKey } from './broadcast';
import { sessionName } from './SessionTabBar';

// Past this many, a list says "and N more".
const LISTED = 6;

export function serverName(serverId: number): string {
    return useServersStore.getState().servers.find((server) => server.id === serverId)?.name ?? `#${serverId}`;
}

export function terminalName(serverId: number, session: TerminalSessionInfo, t: TranslateFn): string {
    return t('terminal.broadcast.terminalName', { server: serverName(serverId), name: sessionName(session, t) });
}

export function terminalNameOf(key: string, t: TranslateFn): string {
    const parsed = parseBroadcastKey(key);
    const session = parsed ? useAppStore.getState().terminalSessions[parsed.serverId]?.sessions.find((item) => item.id === parsed.sessionId) : undefined;
    return parsed && session ? terminalName(parsed.serverId, session, t) : key;
}

export function listTerminals(keys: readonly string[], t: TranslateFn): string {
    const names = keys.slice(0, LISTED).map((key) => terminalNameOf(key, t)).join(', ');
    return keys.length > LISTED ? t('terminal.broadcast.andMore', { list: names, count: keys.length - LISTED }) : names;
}

// chat.danger.<reason in camelCase>: "deletes files recursively"...
export function dangerReasonKey(reason: DangerReason): string {
    return `chat.danger.${reason.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())}`;
}
