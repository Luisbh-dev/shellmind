// Commands the app types into a terminal on someone's behalf (AI, snippets,
// multi-exec, ops panels) are recorded in the audit log when they are
// actually sent. What the user types or picks from the quick commands is
// not, unless it was typed into several terminals at once (broadcast input).
import type { AnyTerminalAttach } from '@shared/protocol';
import type { AuditInput, ClientAuditSource } from '@shared/types';
import { api } from '@/lib/api';
import { maskTerminalSecrets } from '@/lib/terminalSecrets';
import type { CommandSource } from '@/store/appStore';

const AUDITED: Partial<Record<CommandSource, ClientAuditSource>> = {
    ai: 'ai-run',
    'ai-autorun': 'ai-autorun',
    snippet: 'snippet',
    'multi-exec': 'multi-exec',
    ops: 'ops'
};

export function auditSourceFor(source: CommandSource): ClientAuditSource | null {
    return AUDITED[source] ?? null;
}

// `attach`: the tab is a shell inside that container (or pod), not the server's own.
export function auditSentCommand(serverId: number, command: string, source: CommandSource, attach?: AnyTerminalAttach): void {
    const auditSource = auditSourceFor(source);
    if (!auditSource) return;
    post({ serverId, source: auditSource, command, meta: { via: 'terminal', ...attachMeta(attach) } });
}

// A command typed into several terminals at once (broadcast input): each
// terminal records the line it ran, with how many terminals it went to.
// Only lines whose echo confirmed them get here (commandTracker.ts), never
// an answer to a password prompt; snippet secrets still on the server's
// screen are masked.
export function auditBroadcastCommand(serverId: number, command: string, size: number, attach?: AnyTerminalAttach): void {
    post({ serverId, source: 'terminal', command: maskTerminalSecrets(serverId, command), meta: { broadcast: size, ...attachMeta(attach) } });
}

// Where a tab's shell runs when it is not the server's own.
function attachMeta(attach?: AnyTerminalAttach): Record<string, string> {
    if (!attach) return {};
    // W8-T2: a shell inside a Kubernetes pod.
    if (attach.kind === 'pod') return { kind: 'k8s', context: attach.context, namespace: attach.namespace, pod: attach.pod, container: attach.container };
    return { container: attach.container, engine: attach.engine };
}

function post(body: AuditInput & { source: ClientAuditSource }): void {
    api.post('/api/audit', body).catch((error: unknown) => {
        console.warn('Could not record the command in the audit log', error);
    });
}
