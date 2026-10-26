import { ChevronDown, TerminalSquare } from 'lucide-react';
import type { K8sContainerDetail, K8sPod, PodTerminalAttach } from '@shared/k8s';
import { Menu } from '@/components/ui';
import { ToolButton } from '@/features/ops/ui';
import { useT, type TranslateFn } from '@/i18n';
import { useAppStore } from '@/store/appStore';

// "Shell" on a pod: a terminal tab of the server running `kubectl exec -it`
// into one of its containers (bash, else sh), shown at once. Any running
// container will do, readiness aside (a pod failing its readiness probe is
// one to look into), init containers included (one the pod waits for).

export function openPodShell(serverId: number, attach: PodTerminalAttach): void {
    const store = useAppStore.getState();
    store.openTerminalSession(serverId, { attach });
    store.requestServerTab(serverId, 'terminal');
}

// Why no shell can open in the pod now (undefined: it can), from what the
// pod list knows: the containers running now.
export function podShellUnavailable(pod: Pick<K8sPod, 'running' | 'problem'>, t: TranslateFn): string | undefined {
    if (pod.problem === 'terminating') return t('k8s.shell.terminating');
    if (!pod.running.length) return t('k8s.shell.notRunning');
    return undefined;
}

function containerUnavailable(container: K8sContainerDetail, t: TranslateFn): string | undefined {
    if (container.state.state === 'running') return undefined;
    return t('k8s.shell.containerNotRunning', { name: container.name, state: container.state.reason ?? container.state.state });
}

// The containers the detail pane's menu offers: every regular container (a
// stopped one disabled, with its state) and the init containers running now.
export function shellChoices(containers: K8sContainerDetail[]): K8sContainerDetail[] {
    return containers.filter((container) => !container.init || container.state.state === 'running');
}

type PodShellButtonProps = {
    serverId: number;
    context: string;
    pod: K8sPod;
    // The pod's containers with their state (the detail pane): a menu to
    // pick one. Without them the pod's first running container opens.
    containers?: K8sContainerDetail[];
    compact?: boolean;
};

export function PodShellButton({ serverId, context, pod, containers, compact }: PodShellButtonProps) {
    const t = useT();
    const choices = containers ? shellChoices(containers) : [];
    const runningChoice = choices.find((container) => container.state.state === 'running') ?? null;
    const reason = containers
        ? (pod.problem === 'terminating' ? t('k8s.shell.terminating') : runningChoice ? undefined : t('k8s.shell.noRunningContainer'))
        : podShellUnavailable(pod, t);
    const target = containers ? runningChoice?.name : pod.running[0];
    const open = (container: string) => openPodShell(serverId, { kind: 'pod', context, namespace: pod.namespace, pod: pod.name, container });
    const button = (
        <ToolButton
            compact={compact}
            tone={compact ? 'default' : 'primary'}
            icon={<TerminalSquare className={compact ? 'h-4 w-4' : 'h-3.5 w-3.5'} />}
            label={compact ? t('k8s.shell.openIn', { name: pod.name }) : t('k8s.shell.open')}
            disabled={Boolean(reason) || !target}
            disabledReason={reason}
            onClick={() => {
                if (target) open(target);
            }}
        />
    );
    if (compact || choices.length < 2) return button;
    return (
        <span className="inline-flex items-center gap-0.5">
            {button}
            <Menu
                label={t('k8s.shell.choose')}
                align="start"
                triggerClassName="inline-flex h-8 w-7 items-center justify-center rounded-lg border border-brand-500/40 bg-brand-500/15 text-brand-100 hover:bg-brand-500/25 focus-ring"
                items={choices.map((container) => ({
                    id: container.name,
                    label: t(container.init ? 'k8s.shell.inInitContainer' : 'k8s.shell.inContainer', { name: container.name }),
                    hint: containerUnavailable(container, t) ? container.state.reason ?? container.state.state : undefined,
                    disabled: Boolean(containerUnavailable(container, t)) || pod.problem === 'terminating',
                    onSelect: () => open(container.name)
                }))}
            >
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </Menu>
        </span>
    );
}
