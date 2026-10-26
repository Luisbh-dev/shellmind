import { AlertTriangle, Info, Timer } from 'lucide-react';
import type { K8sEvent } from '@shared/k8s';
import { formatTimestamp } from '@/features/ops/format';
import { EmptyState } from '@/features/ops/ui';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatAge } from './model';

// Events as the cluster reports them, warnings first (the backend sorts
// them). `onOpenPod`: a pod's name opens its detail. `compact`: inside a
// pod's detail, without the object column.

type EventListProps = {
    events: K8sEvent[];
    compact?: boolean;
    showNamespace?: boolean;
    onOpenPod?: (name: string, namespace: string) => void;
};

export function EventList({ events, compact, showNamespace, onOpenPod }: EventListProps) {
    const t = useT();
    const language = useLanguage();
    const now = Date.now();
    if (!events.length) {
        return <EmptyState icon={<Timer className="h-5 w-5" />} title={t('k8s.events.empty')} detail={t('k8s.events.emptyHint')} />;
    }
    return (
        <ul className="divide-y divide-white/[0.04]" aria-label={t('k8s.events.label')}>
            {events.map((event, index) => {
                const warning = event.type === 'Warning';
                const Icon = warning ? AlertTriangle : Info;
                const object = `${event.object.kind}/${event.object.name}`;
                const canOpen = onOpenPod && event.object.kind === 'Pod' && event.namespace;
                return (
                    <li key={`${object}-${event.reason}-${index}`} className={cn('flex gap-3 px-4 py-2 text-xs', warning && 'bg-amber-500/[0.04]')}>
                        <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', warning ? 'text-amber-300' : 'text-zinc-500')} aria-hidden="true" />
                        <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                <span className="sr-only">{warning ? t('k8s.events.warning') : t('k8s.events.normal')}</span>
                                <span className={cn('font-semibold', warning ? 'text-amber-100' : 'text-zinc-200')}>{event.reason}</span>
                                {!compact && (
                                    canOpen ? (
                                        <button
                                            type="button"
                                            onClick={() => onOpenPod(event.object.name, event.namespace as string)}
                                            className="min-w-0 truncate rounded font-mono text-[11px] text-brand-300 hover:underline focus-ring"
                                            title={t('k8s.events.openPod', { name: event.object.name })}
                                        >
                                            {object}
                                        </button>
                                    ) : (
                                        <span className="min-w-0 truncate font-mono text-[11px] text-zinc-400">{object}</span>
                                    )
                                )}
                                {showNamespace && event.namespace && <span className="text-[11px] text-zinc-500">{event.namespace}</span>}
                                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-500" title={event.lastAt ? formatTimestamp(event.lastAt, language) : undefined}>
                                    {event.count > 1 ? t('k8s.events.countAgo', { count: event.count, age: formatAge(event.lastAt, now) }) : t('k8s.pods.ago', { age: formatAge(event.lastAt, now) })}
                                </span>
                            </div>
                            <p className="break-words text-zinc-300">{event.message}</p>
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}
