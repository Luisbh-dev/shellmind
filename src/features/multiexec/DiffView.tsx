import { useMemo } from 'react';
import { diffHunks, diffLines } from '@shared/diff';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { plural } from './strategy';

// Hunks shown before "show all" (a diff of two unrelated outputs is long).
const MAX_HUNKS = 40;

const ROW_STYLE = {
    equal: 'text-zinc-400',
    add: 'bg-emerald-500/10 text-emerald-100',
    remove: 'bg-rose-500/10 text-rose-100'
} as const;

const SIGN = { equal: ' ', add: '+', remove: '−' } as const;

// A unified line diff of `base` (the majority's output) against `other`.
export function DiffView({ base, other, baseLabel, otherLabel, trimmed }: { base: string; other: string; baseLabel: string; otherLabel: string; trimmed: boolean }) {
    const t = useT();
    const diff = useMemo(() => diffLines(base, other), [base, other]);
    const hunks = useMemo(() => diffHunks(diff.ops, 3), [diff]);
    const shown = hunks.slice(0, MAX_HUNKS);

    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <span className="inline-flex items-center gap-1 text-rose-200"><span className="font-mono" aria-hidden="true">−</span>{baseLabel}</span>
                <span className="inline-flex items-center gap-1 text-emerald-200"><span className="font-mono" aria-hidden="true">+</span>{otherLabel}</span>
                <span className="text-zinc-500">
                    {t('multiexec.diff.summary', { added: plural(t, 'multiexec.diff.linesAdded', diff.added), removed: plural(t, 'multiexec.diff.linesRemoved', diff.removed) })}
                </span>
            </div>
            {hunks.length === 0 ? (
                <p className="text-xs text-zinc-400">{t(trimmed ? 'multiexec.diff.sameKept' : 'multiexec.diff.sameText')}</p>
            ) : (
                <div className="max-h-80 overflow-auto rounded-lg border border-white/10 bg-ink-900/80 font-mono text-[11px] leading-relaxed scrollbar-thin" role="table" aria-label={t('multiexec.diff.label', { base: baseLabel, other: otherLabel })}>
                    {shown.map((hunk, index) => (
                        <div key={index} role="rowgroup">
                            <div role="row" className="sticky top-0 bg-ink-800/95 px-3 py-0.5 text-[10px] text-sky-300">
                                <span role="cell">@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</span>
                            </div>
                            {hunk.ops.map((op, line) => (
                                <div key={line} role="row" className={cn('grid grid-cols-[2.5rem_2.5rem_1rem_minmax(0,1fr)] px-1', ROW_STYLE[op.type])}>
                                    <span role="cell" className="select-none pr-1 text-right text-zinc-600">{op.oldLine ?? ''}</span>
                                    <span role="cell" className="select-none pr-1 text-right text-zinc-600">{op.newLine ?? ''}</span>
                                    <span role="cell" className="select-none text-center" aria-label={t(`multiexec.diff.${op.type}`)}>{SIGN[op.type]}</span>
                                    <span role="cell" className="whitespace-pre-wrap break-all">{op.text || ' '}</span>
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            )}
            {hunks.length > MAX_HUNKS && <p className="text-[11px] text-zinc-500">{plural(t, 'multiexec.diff.moreHunks', hunks.length - MAX_HUNKS)}</p>}
            {diff.coarse && <p className="text-[11px] text-amber-200">{t('multiexec.diff.coarse')}</p>}
            {trimmed && hunks.length > 0 && <p className="text-[11px] text-zinc-500">{t('multiexec.diff.trimmed')}</p>}
        </div>
    );
}
