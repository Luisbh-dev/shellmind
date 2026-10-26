import { useId, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui';
import { useT } from '@/i18n';
import { STARTER_SNIPPETS } from './starters';

interface StarterOfferProps {
    importing: boolean;
    // The library is empty (first open) rather than opened from the toolbar.
    firstRun: boolean;
    onImport: (keys: string[]) => void;
    onDismiss: () => void;
}

export function StarterOffer({ importing, firstRun, onImport, onDismiss }: StarterOfferProps) {
    const t = useT();
    const id = useId();
    const [selected, setSelected] = useState<Set<string>>(() => new Set(STARTER_SNIPPETS.map((starter) => starter.key)));

    const toggle = (key: string) => setSelected((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    });

    return (
        <section aria-labelledby={`${id}-title`} className="space-y-4">
            <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-300">
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                </span>
                <div>
                    <h3 id={`${id}-title`} className="text-sm font-semibold text-zinc-100">{t('snippets.starters.title')}</h3>
                    <p className="mt-0.5 text-xs text-zinc-400">{firstRun ? t('snippets.starters.introEmpty') : t('snippets.starters.intro')}</p>
                </div>
            </div>

            <ul className="space-y-2">
                {STARTER_SNIPPETS.map((starter) => {
                    const checkboxId = `${id}-${starter.key}`;
                    return (
                        <li key={starter.key} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
                            <div className="flex items-start gap-3">
                                <input
                                    id={checkboxId}
                                    type="checkbox"
                                    checked={selected.has(starter.key)}
                                    onChange={() => toggle(starter.key)}
                                    className="mt-1 h-4 w-4 shrink-0 accent-brand-500"
                                />
                                <div className="min-w-0 flex-1">
                                    <label htmlFor={checkboxId} className="block cursor-pointer text-sm font-medium text-zinc-100">
                                        {t(`snippets.starters.${starter.key}.name`)}
                                    </label>
                                    <p className="text-xs text-zinc-400">{t(`snippets.starters.${starter.key}.description`)}</p>
                                    <code className="mt-1 block truncate font-mono text-[11px] text-zinc-400" title={starter.command}>{starter.command}</code>
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ul>

            <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onDismiss} disabled={importing}>
                    {firstRun ? t('snippets.starters.notNow') : t('common.cancel')}
                </Button>
                <Button
                    variant="primary"
                    size="sm"
                    loading={importing}
                    disabled={selected.size === 0}
                    onClick={() => onImport(STARTER_SNIPPETS.filter((starter) => selected.has(starter.key)).map((starter) => starter.key))}
                >
                    {t('snippets.starters.import', { count: selected.size })}
                </Button>
            </div>
        </section>
    );
}
