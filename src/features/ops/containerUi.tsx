import { ChevronDown, TerminalSquare } from 'lucide-react';
import { CONTAINER_SHELLS, type ContainerEngine, type ContainerInfo, type OpsCapabilities } from '@shared/ops';
import { Menu } from '@/components/ui';
import { useT } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { ToolButton, type BadgeTone } from './ui';

// Pieces the containers and Compose views share.

export function containerTone(container: Pick<ContainerInfo, 'state' | 'status'>): BadgeTone {
    // "Up 2 hours (unhealthy)": running but failing its health check.
    if (/\(unhealthy\)/i.test(container.status)) return 'bad';
    if (container.state === 'running') return /\(health: starting\)/i.test(container.status) ? 'warn' : 'ok';
    if (container.state === 'restarting' || container.state === 'paused' || container.state === 'removing') return 'warn';
    if (container.state === 'dead') return 'bad';
    // "Exited (137) 2 hours ago": a non-zero exit is a failure.
    const exit = /Exited \((\d+)\)/.exec(container.status);
    if (exit && exit[1] !== '0') return 'bad';
    return 'idle';
}

// The engines' state words (ops.containers.states.*); another one is shown as the engine says it.
const STATES = new Set(['running', 'unhealthy', 'exited', 'stopped', 'created', 'configured', 'initialized', 'restarting', 'paused', 'removing', 'dead', 'unknown']);

// The state word of a container's badge: a running container failing its
// health check reads "unhealthy" (Docker only says so in the status text).
export function containerStateLabel(container: Pick<ContainerInfo, 'state' | 'status'>, t: ReturnType<typeof useT>): string {
    const state = container.state === 'running' && /\(unhealthy\)/i.test(container.status) ? 'unhealthy' : container.state;
    return STATES.has(state) ? t(`ops.containers.states.${state}`) : state;
}

// `docker compose ls` sums a project up as "running(2), exited(1)": the
// same with the state words translated.
export function composeStatusLabel(status: string, t: ReturnType<typeof useT>): string {
    return status.replace(/\b([a-z]+)\((\d+)\)/g, (whole, state: string, count: string) => (STATES.has(state) ? `${t(`ops.containers.states.${state}`)} (${count})` : whole));
}

// A terminal tab of the server inside the container (bash, else sh, unless
// `shell` is given), shown at once.
export function openContainerShell(serverId: number, engine: ContainerEngine, container: string, shell?: string): void {
    const store = useAppStore.getState();
    store.openTerminalSession(serverId, { attach: { kind: 'container', engine, container, ...(shell ? { shell } : {}) } });
    store.requestServerTab(serverId, 'terminal');
}

// Why no shell can be opened in the container now (undefined: it can).
export function shellUnavailableReason(caps: OpsCapabilities, container: Pick<ContainerInfo, 'state'>, t: ReturnType<typeof useT>): string | undefined {
    if (caps.platform !== 'linux') return t('ops.containers.shell.linuxOnly');
    if (container.state !== 'running') return t('ops.containers.shell.notRunning');
    return undefined;
}

type ShellButtonProps = {
    serverId: number;
    caps: OpsCapabilities;
    container: Pick<ContainerInfo, 'name' | 'state'>;
    // Icon only (table rows).
    compact?: boolean;
};

// "Open shell", plus a menu to pick the shell (the main button lets the
// server choose bash or sh).
export function ShellButton({ serverId, caps, container, compact }: ShellButtonProps) {
    const t = useT();
    const engine = caps.containers.engine;
    const reason = shellUnavailableReason(caps, container, t);
    if (!engine) return null;
    const open = (shell?: string) => openContainerShell(serverId, engine, container.name, shell);
    const button = (
        <ToolButton
            compact={compact}
            tone={compact ? 'default' : 'primary'}
            icon={<TerminalSquare className={compact ? 'h-4 w-4' : 'h-3.5 w-3.5'} />}
            label={compact ? t('ops.containers.shell.openIn', { name: container.name }) : t('ops.containers.shell.open')}
            disabled={Boolean(reason)}
            disabledReason={reason}
            onClick={() => open()}
        />
    );
    if (compact) return button;
    return (
        <span className="inline-flex items-center gap-0.5">
            {button}
            {!reason && (
                <Menu
                    label={t('ops.containers.shell.choose')}
                    align="start"
                    triggerClassName="inline-flex h-8 w-7 items-center justify-center rounded-lg border border-brand-500/40 bg-brand-500/15 text-brand-100 hover:bg-brand-500/25 focus-ring"
                    items={CONTAINER_SHELLS.map((shell) => ({ id: shell, label: t('ops.containers.shell.with', { shell }), onSelect: () => open(shell) }))}
                >
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </Menu>
            )}
        </span>
    );
}
