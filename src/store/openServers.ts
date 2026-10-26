// Which work closing an open server would end, and which open server makes
// room for another one. App asks before closing a server that has any.
import { t } from '@/i18n';
import { MAX_OPEN_SERVERS, collectUnsavedWork, useAppStore } from './appStore';

// Terminal tabs of the server that are connected right now.
export function liveSessionCount(serverId: number): number {
    const sessions = useAppStore.getState().terminalSessions[serverId]?.sessions ?? [];
    return sessions.filter((session) => session.state === 'connected').length;
}

// Everything closing `serverId` would lose, one translated phrase each: what
// its panels registered (unsaved editor changes, transfers in progress) and
// its live terminal sessions.
export function describeOpenWork(serverId: number): string[] {
    const work = collectUnsavedWork(serverId);
    const sessions = liveSessionCount(serverId);
    if (sessions === 1) work.push(t('app.openServers.work.session'));
    else if (sessions > 1) work.push(t('app.openServers.work.sessions', { count: sessions }));
    return work;
}

export type Eviction = { serverId: number; work: string[] } | null;

// The open server to close so that `opening` fits: the least recently used
// one without any work; if all have some, the least recently used one (with
// its work, so the caller can ask first). null when there is room.
export function pickEviction(
    openServerIds: readonly number[],
    opening: number,
    describe: (serverId: number) => string[] = describeOpenWork,
    max = MAX_OPEN_SERVERS
): Eviction {
    if (openServerIds.includes(opening) || openServerIds.length < max) return null;
    const leastRecentFirst = [...openServerIds].reverse();
    for (const serverId of leastRecentFirst) {
        const work = describe(serverId);
        if (!work.length) return { serverId, work };
    }
    const serverId = leastRecentFirst[0];
    return { serverId, work: describe(serverId) };
}
