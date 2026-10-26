import { useT } from '@/i18n';
import { cn } from '@/lib/cn';

export type BatchState = 'pending' | 'current' | 'done' | 'failed' | 'skipped';

const STATE_STYLE: Record<BatchState, string> = {
    pending: 'border-white/10 bg-white/[0.03] text-zinc-400',
    current: 'border-brand-500/50 bg-brand-500/15 text-brand-200',
    done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    failed: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
    skipped: 'border-white/5 bg-transparent text-zinc-500'
};

// Labels fit inside the segments up to this many batches.
const MAX_LABELLED = 14;

// The batches of a job side by side, each as wide as its share of servers:
// the plan in the composer, the progress in a job.
export function BatchStrip({ sizes, canary, states }: { sizes: readonly number[]; canary: boolean; states?: readonly BatchState[] }) {
    const t = useT();
    if (sizes.length <= 1 && !canary) return null;
    const labelled = sizes.length <= MAX_LABELLED;
    return (
        <ol className="flex gap-1" aria-label={t('multiexec.plan.batchesLabel')}>
            {sizes.map((size, index) => {
                const isCanary = canary && index === 0;
                const number = canary ? index : index + 1;
                const state = states?.[index] ?? 'pending';
                const name = isCanary ? t('multiexec.plan.canaryName') : t('multiexec.plan.batchName', { number });
                const description = `${name}: ${t(size === 1 ? 'multiexec.plan.servers.one' : 'multiexec.plan.servers.other', { count: size })}${states ? ` · ${t(`multiexec.plan.state.${state}`)}` : ''}`;
                return (
                    <li
                        key={index}
                        title={description}
                        aria-label={description}
                        aria-current={state === 'current' ? 'step' : undefined}
                        style={{ flexGrow: size, flexBasis: 0 }}
                        className={cn(
                            'flex h-6 min-w-[1.25rem] items-center justify-center overflow-hidden rounded-md border px-1 text-[10px] font-medium tabular-nums transition-colors',
                            STATE_STYLE[state],
                            isCanary && state === 'pending' && 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                        )}
                    >
                        {labelled && (
                            <span className="truncate" aria-hidden="true">
                                {isCanary ? t('multiexec.plan.canaryShort', { count: size }) : size}
                            </span>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}
