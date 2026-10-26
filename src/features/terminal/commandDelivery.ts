import { useAppStore, type CommandSource, type QueuedCommand } from '@/store/appStore';

// Commands queued for a server's terminal (useAppStore.queueCommand) that the
// terminal did not type, reported to whoever queued them: Auto-Run ends its
// chain instead of waiting for output that never comes.
//   full-screen    a full-screen program (vi, less, top) held the terminal
//   no-prompt      a block of lines, and no shell prompt in sight
//   not-connected  the session ended before it was typed
//   declined       the user was asked and said no
//   discarded      the user discarded the waiting commands
//   container-shell  the focused tab is a shell inside a container, not the
//                  server's (Auto-Run steps only; other commands wait there)
// Auto-Run steps ('ai-autorun') are typed right away into a shell prompt or
// not at all: they are never held for later, and the user is not asked
// (Auto-Run's own timers would run meanwhile).
export type UndeliveredReason = 'full-screen' | 'no-prompt' | 'not-connected' | 'container-shell' | 'declined' | 'discarded';

export type UndeliveredCommand = {
    serverId: number;
    command: string;
    source: CommandSource;
    reason: UndeliveredReason;
};

type Listener = (report: UndeliveredCommand) => void;

const listeners = new Set<Listener>();

// Calls `listener` for every command a terminal did not type; returns its
// unsubscription (an effect's cleanup).
export function onCommandUndelivered(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function reportUndelivered(entry: Pick<QueuedCommand, 'command' | 'source'>, serverId: number, reason: UndeliveredReason): void {
    const report: UndeliveredCommand = { serverId, command: entry.command, source: entry.source, reason };
    for (const listener of [...listeners]) {
        try {
            listener(report);
        } catch {
            // One broken listener must not keep the report from the others.
        }
    }
}

// Takes the server's queued commands that `pick` selects out of the queue;
// the others stay queued as they were (order, ids, queue time).
export function takeQueuedWhere(serverId: number, pick: (entry: QueuedCommand) => boolean): QueuedCommand[] {
    let taken: QueuedCommand[] = [];
    useAppStore.setState((state) => {
        const queued = state.pendingCommands[serverId] ?? [];
        taken = queued.filter(pick);
        if (!taken.length) return state;
        const kept = queued.filter((entry) => !pick(entry));
        const pendingCommands = { ...state.pendingCommands };
        if (kept.length) pendingCommands[serverId] = kept;
        else delete pendingCommands[serverId];
        return { pendingCommands };
    });
    return taken;
}

export const isAutoRunStep = (entry: Pick<QueuedCommand, 'source'>): boolean => entry.source === 'ai-autorun';
