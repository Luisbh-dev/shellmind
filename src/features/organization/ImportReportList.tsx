import type { ImportOutcome, ImportReport } from '@shared/organization';
import { useT, type TranslateFn } from '@/i18n';

export function skipReasonText(t: TranslateFn, outcome: ImportOutcome): string {
    const reason = t(`organization.report.reasons.${outcome.reason ?? 'invalid'}`, { detail: outcome.detail ?? '' });
    return outcome.reason === 'invalid' && outcome.detail ? `${reason}: ${outcome.detail}` : reason;
}

// "1 created" / "3 created", or in a preview "will be added".
function countLabel(t: TranslateFn, kind: 'created' | 'skipped', count: number, preview: boolean): string {
    const key = preview ? (kind === 'created' ? 'willCreate' : 'willSkip') : kind;
    return count === 1 ? t(`organization.report.${key}.one`) : t(`organization.report.${key}.many`, { count });
}

// What an import created (or, in a preview, would create) and what it skipped, with the reason.
export function ImportReportList({ report, title, preview = false }: { report: ImportReport; title?: string; preview?: boolean }) {
    const t = useT();
    if (report.created.length === 0 && report.skipped.length === 0) return null;
    return (
        <div className="space-y-1.5 text-xs">
            {title && <h4 className="font-semibold uppercase tracking-wider text-zinc-300">{title}</h4>}
            {report.created.length > 0 && (
                <p className="text-emerald-300">
                    {countLabel(t, 'created', report.created.length, preview)}{' '}
                    <span className="text-zinc-300">{report.created.map((outcome) => outcome.name).join(', ')}</span>
                </p>
            )}
            {report.skipped.length > 0 && (
                <div>
                    <p className="text-amber-300">{countLabel(t, 'skipped', report.skipped.length, preview)}</p>
                    <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto scrollbar-thin pl-3 text-zinc-400">
                        {report.skipped.map((outcome, index) => (
                            <li key={`${outcome.name}-${index}`} className="break-words">
                                <span className="text-zinc-200">{outcome.name || '—'}</span> · {skipReasonText(t, outcome)}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
