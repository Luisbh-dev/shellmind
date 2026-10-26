import { useId } from 'react';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { DangerMatch } from '@shared/commandSafety';
import { planBatches } from '@shared/multiexec';
import { Input } from '@/components/ui';
import { useT } from '@/i18n';
import { CommandPreview } from '@/features/snippets/public';
import { BatchStrip } from './BatchStrip';
import type { ComposerDerived } from './composerState';
import { describePlan, plural } from './strategy';

// camelCase i18n keys of the danger reasons.
export const DANGER_KEYS: Record<DangerMatch['reason'], string> = {
    'recursive-delete': 'recursiveDelete',
    disk: 'disk',
    power: 'power',
    'fork-bomb': 'forkBomb',
    permissions: 'permissions',
    database: 'database',
    firewall: 'firewall',
    'cloud-delete': 'cloudDelete',
    'container-data': 'containerData',
    processes: 'processes',
    scheduler: 'scheduler',
    'remote-code': 'remoteCode',
    backdoor: 'backdoor',
    overwrite: 'overwrite'
};

interface ConfirmViewProps {
    derived: ComposerDerived;
    danger: DangerMatch | null;
    // The danger line as shown (secret values masked).
    dangerLine: string | null;
    typed: string;
    onTypedChange: (text: string) => void;
}

// The last look before a job starts: what runs where, how it rolls out, and
// for a destructive command a typed confirmation (the number of servers).
export function ConfirmView({ derived, danger, dangerLine, typed, onTypedChange }: ConfirmViewProps) {
    const t = useT();
    const id = useId();
    const { targets, strategy } = derived;
    const plan = strategy ? describePlan(strategy, targets.length, t) : [];
    const sizes = strategy ? planBatches(targets.length, strategy) : [];

    return (
        <section aria-labelledby={`${id}-title`} className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 scrollbar-thin">
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                <div>
                    {/* Focused when the review shows, unless a typed confirmation is asked for. */}
                    <h3
                        id={`${id}-title`}
                        tabIndex={-1}
                        data-view-focus={danger ? undefined : true}
                        className="w-fit rounded text-sm font-semibold text-amber-100 focus-ring"
                    >
                        {plural(t, 'multiexec.confirm.title', targets.length)}
                    </h3>
                    <p className="mt-0.5 text-xs text-amber-200/80">
                        {t('multiexec.confirm.details', { timeout: derived.timeoutSec ?? 0, concurrency: strategy?.concurrency ?? 0 })}
                    </p>
                </div>
            </div>

            {danger && (
                <div role="group" aria-labelledby={`${id}-danger`} className="space-y-2.5 rounded-xl border border-rose-500/40 bg-rose-500/[0.08] px-4 py-3">
                    <div className="flex items-start gap-3">
                        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" />
                        <div className="min-w-0 space-y-1">
                            <h4 id={`${id}-danger`} className="text-sm font-semibold text-rose-100">{t('multiexec.danger.title')}</h4>
                            <p className="text-xs text-rose-200/90">{plural(t, 'multiexec.danger.message', targets.length, { reason: t(`multiexec.danger.reasons.${DANGER_KEYS[danger.reason]}`) })}</p>
                            {dangerLine && <pre className="whitespace-pre-wrap break-all rounded-md bg-black/20 px-2 py-1 font-mono text-[11px] text-rose-100">{dangerLine}</pre>}
                        </div>
                    </div>
                    <div className="space-y-1.5 pl-7">
                        <label htmlFor={`${id}-typed`} className="block text-xs text-rose-100">{t('multiexec.danger.typeToConfirm', { count: targets.length })}</label>
                        <Input
                            id={`${id}-typed`}
                            value={typed}
                            onChange={(event) => onTypedChange(event.target.value)}
                            inputMode="numeric"
                            autoComplete="off"
                            data-view-focus
                            className="h-8 w-32 py-1 font-mono text-xs"
                            aria-describedby={`${id}-danger`}
                        />
                    </div>
                </div>
            )}

            <CommandPreview label={t('multiexec.confirm.command')} command={derived.display} note={derived.hidesValues ? t('multiexec.compose.secretsHidden') : null} />
            {derived.snippetRef && <p className="text-xs text-zinc-400">{t('multiexec.compose.fromSnippet', { name: derived.snippetRef.name })}</p>}

            {plan.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('multiexec.plan.title')}</h4>
                    <BatchStrip sizes={sizes} canary={Boolean(strategy?.canary)} />
                    <ul className="space-y-0.5 text-xs text-zinc-300">
                        {plan.map((line) => <li key={line}>{line}</li>)}
                    </ul>
                </div>
            )}

            <div className="space-y-1.5">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('multiexec.confirm.servers')}</h4>
                <ul className="flex flex-wrap gap-1.5">
                    {targets.map((target) => (
                        <li key={target.id} className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-zinc-200">
                            {target.name} <span className="font-mono text-zinc-500">{target.ip}</span>
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    );
}
