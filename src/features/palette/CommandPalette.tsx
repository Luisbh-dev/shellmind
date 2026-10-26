import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';
import { Kbd, Modal } from '@/components/ui';
import { rankItems, type PaletteItem, type PaletteSection, type RankedItem } from './items';

interface CommandPaletteProps {
    open: boolean;
    onClose: () => void;
    items: PaletteItem[];
}

// The label with the matched characters highlighted.
function Highlighted({ text, positions }: { text: string; positions: number[] }) {
    if (positions.length === 0) return <>{text}</>;
    const marked = new Set(positions);
    return (
        <>
            {[...text].map((char, index) => (marked.has(index)
                ? <mark key={index} className="bg-transparent font-semibold text-brand-300">{char}</mark>
                : <Fragment key={index}>{char}</Fragment>))}
        </>
    );
}

/**
 * Ctrl+K palette: fuzzy search over servers, workspace tabs, global actions
 * and app commands. Keyboard driven (ARIA combobox + listbox): arrows,
 * PageUp/PageDown, Enter runs, Escape closes.
 */
export function CommandPalette({ open, onClose, items }: CommandPaletteProps) {
    const t = useT();
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const listId = useId();
    const optionId = (index: number) => `${listId}-${index}`;

    useEffect(() => {
        if (!open) return;
        setQuery('');
        setActive(0);
    }, [open]);

    const results = useMemo(() => rankItems(items, query), [items, query]);
    const searching = query.trim().length > 0;

    // Without a query the results are shown per section; a search is one list.
    const groups = useMemo(() => {
        const runs: Array<{ section: PaletteSection; start: number; results: RankedItem[] }> = [];
        results.forEach((result, index) => {
            const last = runs[runs.length - 1];
            if (last && (searching || last.section === result.item.section)) last.results.push(result);
            else runs.push({ section: result.item.section, start: index, results: [result] });
        });
        return runs;
    }, [results, searching]);

    useEffect(() => {
        setActive((index) => Math.min(index, Math.max(0, results.length - 1)));
    }, [results.length]);

    useEffect(() => {
        if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
    });

    const run = (item: PaletteItem | undefined) => {
        if (!item) return;
        onClose();
        // After the palette closed and gave focus back.
        window.setTimeout(item.run, 0);
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        const last = results.length - 1;
        const moves: Record<string, number> = {
            ArrowDown: active >= last ? 0 : active + 1,
            ArrowUp: active <= 0 ? last : active - 1,
            PageDown: Math.min(last, active + 8),
            PageUp: Math.max(0, active - 8)
        };
        if (event.key in moves) {
            event.preventDefault();
            setActive(Math.max(0, moves[event.key]));
        } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            run(results[active]?.item);
        }
    };

    const sectionLabel = (section: PaletteSection) => t(`palette.sections.${section}`);

    return (
        <Modal
            open={open}
            onClose={onClose}
            ariaLabel={t('palette.title')}
            widthClass="max-w-xl"
            align="top"
            bodyClassName="p-0"
        >
            <div className="flex items-center gap-2.5 border-b border-white/5 px-4">
                <Search className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
                <input
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setActive(0);
                    }}
                    onKeyDown={onKeyDown}
                    role="combobox"
                    aria-expanded="true"
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={results.length ? optionId(active) : undefined}
                    aria-label={t('palette.inputLabel')}
                    placeholder={t('palette.placeholder')}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-12 min-w-0 flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
                />
                <Kbd>{t('common.keys.escape')}</Kbd>
            </div>

            <div id={listId} role="listbox" aria-label={t('palette.results')} className="max-h-[min(60vh,28rem)] overflow-y-auto scrollbar-thin p-1.5">
                {groups.map((group) => (
                    <div key={`${group.section}-${group.start}`} role="group" aria-label={searching ? undefined : sectionLabel(group.section)}>
                        {!searching && (
                            <div aria-hidden="true" className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                                {sectionLabel(group.section)}
                            </div>
                        )}
                        {group.results.map(({ item, positions }, offset) => {
                            const index = group.start + offset;
                            const Icon = item.icon;
                            return (
                                <div
                                    key={item.id}
                                    id={optionId(index)}
                                    role="option"
                                    aria-selected={index === active}
                                    tabIndex={-1}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onMouseMove={() => { if (index !== active) setActive(index); }}
                                    onClick={() => run(item)}
                                    onKeyDown={(event) => { if (event.key === 'Enter') run(item); }}
                                    className={cn(
                                        'flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm',
                                        index === active ? 'bg-brand-500/15 text-zinc-50' : 'text-zinc-300'
                                    )}
                                >
                                    {item.iconNode ?? <Icon className={cn('h-4 w-4 shrink-0', index === active ? 'text-brand-300' : 'text-zinc-400')} aria-hidden="true" />}
                                    <span className="min-w-0 flex-1 truncate">
                                        <Highlighted text={item.label} positions={positions} />
                                        {item.detail && <span className="ml-2 font-mono text-xs text-zinc-400">{item.detail}</span>}
                                        {item.current && <span className="sr-only"> {t('palette.current')}</span>}
                                    </span>
                                    {item.current && <Check className="h-4 w-4 shrink-0 text-brand-300" aria-hidden="true" />}
                                    {searching && <span className="shrink-0 text-[11px] text-zinc-400">{sectionLabel(item.section)}</span>}
                                    {item.shortcut && <Kbd className="shrink-0">{item.shortcut}</Kbd>}
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
            {results.length === 0 && (
                <p role="status" className="px-3 pb-8 pt-4 text-center text-sm text-zinc-400">{t('palette.empty')}</p>
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/5 px-4 py-2 text-[11px] text-zinc-400" aria-hidden="true">
                <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> {t('palette.hints.navigate')}</span>
                <span><Kbd>{t('common.keys.enter')}</Kbd> {t('palette.hints.run')}</span>
                <span><Kbd>{t('common.keys.escape')}</Kbd> {t('palette.hints.close')}</span>
            </div>
        </Modal>
    );
}
