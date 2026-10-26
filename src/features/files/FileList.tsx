import { memo, useCallback, useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
    ArrowDown, ArrowUp, Download, File as FileIcon, FileArchive, FileCode, FileImage, FileText, Folder, Link2, Pencil, SquarePen, Trash2
} from 'lucide-react';
import type { FileEntry } from '@shared/files';
import { cn } from '@/lib/cn';
import { useT, type Language } from '@/i18n';
import { fileKind, formatBytes, formatDate, formatPermissions, type FileKind, type SortKey, type SortState } from './listing';
import { clickSelect, findByPrefix, moveFocus, selectAll, toggle, type Selection } from './selection';

export const ROW_HEIGHT = 36;
const TYPE_AHEAD_RESET_MS = 700;

// Columns: checkbox, name, size, [modified], [permissions], actions. The
// optional ones follow the width of the list (a container), not the window's:
// the panel shares the window with the sidebar and the chat.
const COLUMNS = 'grid grid-cols-[2.25rem_minmax(0,1fr)_5.5rem_6.5rem] [@container(min-width:36rem)]:grid-cols-[2.25rem_minmax(0,1fr)_5.5rem_10.5rem_6.5rem] [@container(min-width:46rem)]:grid-cols-[2.25rem_minmax(0,1fr)_5.5rem_10.5rem_4.5rem_6.5rem]';
const MODIFIED_CELL = 'hidden [@container(min-width:36rem)]:block';
const PERMISSIONS_CELL = 'hidden [@container(min-width:46rem)]:block';

export type RowAction = 'open' | 'edit' | 'download' | 'rename' | 'delete';

const ICONS: Record<FileKind, React.ReactElement> = {
    folder: <Folder className="h-4 w-4 shrink-0 fill-brand-500/20 text-brand-400" aria-hidden />,
    archive: <FileArchive className="h-4 w-4 shrink-0 text-amber-400/80" aria-hidden />,
    image: <FileImage className="h-4 w-4 shrink-0 text-fuchsia-400/80" aria-hidden />,
    code: <FileCode className="h-4 w-4 shrink-0 text-brand-400/80" aria-hidden />,
    text: <FileText className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />,
    binary: <FileIcon className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />,
    other: <FileIcon className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
};

type RowProps = {
    // entryKey(entry), what the selection holds.
    rowKey: string;
    entry: FileEntry;
    language: Language;
    index: number;
    top: number;
    selected: boolean;
    focused: boolean;
    rowId: string;
    maxEditBytes: number;
    onToggle: (name: string) => void;
    onAction: (action: RowAction, entry: FileEntry) => void;
};

// Sizes, dates and permissions are formatted here, for the rows on screen
// only: a 20,000-entry folder does not format 20,000 rows per keystroke.
const FileRow = memo(function FileRow({ rowKey, entry, language, index, top, selected, focused, rowId, maxEditBytes, onToggle, onAction }: RowProps) {
    const t = useT();
    const kind = fileKind(entry);
    const canEdit = !entry.isDir && entry.size <= maxEditBytes && kind !== 'binary' && kind !== 'archive';
    const actionClass = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100';
    return (
        <div
            role="row"
            id={rowId}
            aria-rowindex={index + 2}
            aria-selected={selected}
            data-index={index}
            className={cn(
                COLUMNS,
                'group absolute left-0 right-0 cursor-default items-center border-b border-white/[0.03] text-[13px] transition-colors',
                selected ? 'bg-brand-500/[0.12]' : 'hover:bg-white/[0.03]',
                focused && 'shadow-[inset_0_0_0_1px_rgb(var(--c-brand-400)/0.55)]'
            )}
            style={{ height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
        >
            <div role="gridcell" className="flex items-center justify-center">
                <input
                    type="checkbox"
                    tabIndex={-1}
                    checked={selected}
                    onChange={() => onToggle(rowKey)}
                    aria-label={t('files.list.selectRow', { name: entry.name })}
                    className="h-3.5 w-3.5 cursor-pointer accent-brand-500"
                />
            </div>
            <div role="gridcell" className="flex min-w-0 items-center gap-2 pr-2">
                {ICONS[kind]}
                <span className={cn('truncate', selected ? 'text-zinc-50' : 'text-zinc-200', entry.name.startsWith('.') && !selected && 'text-zinc-400')} title={entry.name}>
                    {entry.name}
                </span>
                {entry.isLink && <Link2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-label={t('files.list.link')} />}
            </div>
            <div role="gridcell" className="pr-3 text-right font-mono text-xs text-zinc-400">{entry.isDir ? '' : formatBytes(entry.size, language)}</div>
            <div role="gridcell" className={cn(MODIFIED_CELL, 'truncate pr-3 text-right text-xs text-zinc-400')}>{formatDate(entry.mtime, language)}</div>
            <div role="gridcell" className={cn(PERMISSIONS_CELL, 'pr-3 text-right font-mono text-xs text-zinc-500')}>{formatPermissions(entry.permissions)}</div>
            <div role="gridcell" className={cn('flex items-center justify-end gap-0.5 pr-2 opacity-0 transition-opacity group-hover:opacity-100', (selected || focused) && 'opacity-100')}>
                {!entry.isDir && (
                    <>
                        {canEdit && (
                            <button type="button" tabIndex={-1} className={actionClass} onClick={() => onAction('edit', entry)} aria-label={`${t('files.actions.edit')} ${entry.name}`} title={t('files.actions.edit')}>
                                <SquarePen className="h-3.5 w-3.5" />
                            </button>
                        )}
                        <button type="button" tabIndex={-1} className={actionClass} onClick={() => onAction('download', entry)} aria-label={`${t('files.actions.download')} ${entry.name}`} title={t('files.actions.download')}>
                            <Download className="h-3.5 w-3.5" />
                        </button>
                    </>
                )}
                <button type="button" tabIndex={-1} className={actionClass} onClick={() => onAction('rename', entry)} aria-label={`${t('files.actions.rename')} ${entry.name}`} title={t('files.actions.rename')}>
                    <Pencil className="h-3.5 w-3.5" />
                </button>
                <button type="button" tabIndex={-1} className={cn(actionClass, 'hover:bg-rose-500/15 hover:text-rose-300')} onClick={() => onAction('delete', entry)} aria-label={`${t('files.actions.delete')} ${entry.name}`} title={t('files.actions.delete')}>
                    <Trash2 className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    );
});

export type FileListProps = {
    id: string;
    path: string;
    entries: FileEntry[];
    // entryKey() of each entry, in the same order.
    keys: string[];
    selection: Selection;
    onSelectionChange: (selection: Selection) => void;
    sort: SortState;
    onSort: (key: SortKey) => void;
    language: Language;
    maxEditBytes: number;
    // Shown by the explorer above the rows (empty folder, no matches...).
    emptyState?: React.ReactNode;
    onOpen: (entry: FileEntry) => void;
    onAction: (action: RowAction, entry: FileEntry) => void;
    onUp: () => void;
    onDeleteSelection: () => void;
    onRenameFocused: () => void;
    gridRef: React.RefObject<HTMLDivElement>;
};

export function FileList({
    id, path, entries, keys, selection, onSelectionChange, sort, onSort, language, maxEditBytes, emptyState,
    onOpen, onAction, onUp, onDeleteSelection, onRenameFocused, gridRef
}: FileListProps) {
    const t = useT();
    const typeAhead = useRef({ text: '', at: 0 });
    const indexOf = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);

    const virtualizer = useVirtualizer({
        count: entries.length,
        getScrollElement: () => gridRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
        paddingStart: ROW_HEIGHT,
        scrollPaddingStart: ROW_HEIGHT
    });

    const focusIndex = selection.focus === null ? -1 : indexOf.get(selection.focus) ?? -1;
    useEffect(() => {
        if (focusIndex >= 0) virtualizer.scrollToIndex(focusIndex, { align: 'auto' });
    }, [focusIndex, virtualizer]);

    // Back to the top when another folder is shown.
    useEffect(() => {
        gridRef.current?.scrollTo?.({ top: 0 });
    }, [path, gridRef]);

    const selectionRef = useRef(selection);
    selectionRef.current = selection;
    const onToggle = useCallback((key: string) => onSelectionChange(toggle(selectionRef.current, key)), [onSelectionChange]);

    const indexAt = (target: EventTarget | null): number => {
        const row = (target as HTMLElement | null)?.closest?.('[data-index]');
        const index = row ? Number(row.getAttribute('data-index')) : -1;
        return index >= 0 && index < entries.length ? index : -1;
    };
    const isControl = (target: EventTarget | null) => !!(target as HTMLElement | null)?.closest?.('input, button');

    const handleClick = (event: MouseEvent<HTMLDivElement>) => {
        if (isControl(event.target)) return;
        const index = indexAt(event.target);
        if (index < 0) return;
        onSelectionChange(clickSelect(selection, keys, keys[index], { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey }));
    };

    const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
        if (isControl(event.target)) return;
        const index = indexAt(event.target);
        if (index >= 0) onOpen(entries[index]);
    };

    const pageSize = Math.max(1, Math.floor((gridRef.current?.clientHeight ?? ROW_HEIGHT * 10) / ROW_HEIGHT) - 1);

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        const mod = event.ctrlKey || event.metaKey;
        const modifiers = { shift: event.shiftKey, ctrl: mod };
        const focused = focusIndex >= 0 ? entries[focusIndex] ?? null : null;
        let handled = true;
        switch (event.key) {
            case 'ArrowDown': onSelectionChange(moveFocus(selection, keys, 1, modifiers)); break;
            case 'ArrowUp': onSelectionChange(moveFocus(selection, keys, -1, modifiers)); break;
            case 'PageDown': onSelectionChange(moveFocus(selection, keys, pageSize, modifiers)); break;
            case 'PageUp': onSelectionChange(moveFocus(selection, keys, -pageSize, modifiers)); break;
            case 'Home': onSelectionChange(moveFocus(selection, keys, 'first', modifiers)); break;
            case 'End': onSelectionChange(moveFocus(selection, keys, 'last', modifiers)); break;
            case 'Enter': if (focused) onOpen(focused); break;
            case 'Backspace': onUp(); break;
            case 'Delete': onDeleteSelection(); break;
            case 'F2': onRenameFocused(); break;
            case 'Escape': onSelectionChange({ ...selection, selected: new Set(), anchor: null }); break;
            case ' ':
                if (selection.focus !== null) onSelectionChange(toggle(selection, selection.focus));
                else onSelectionChange(moveFocus(selection, keys, 'first'));
                break;
            default:
                if (mod && event.key.toLowerCase() === 'a') {
                    onSelectionChange(selectAll(keys, selection));
                } else if (!mod && !event.altKey && event.key.length === 1) {
                    // Type-ahead: jump to the next name starting with what was typed.
                    const now = Date.now();
                    const buffer = now - typeAhead.current.at > TYPE_AHEAD_RESET_MS ? event.key : typeAhead.current.text + event.key;
                    typeAhead.current = { text: buffer, at: now };
                    const match = findByPrefix(entries.map((entry) => entry.name), buffer, focusIndex);
                    if (match >= 0) onSelectionChange(clickSelect(selection, keys, keys[match]));
                } else {
                    handled = false;
                }
        }
        if (handled) event.preventDefault();
    };

    const allSelected = keys.length > 0 && selection.selected.size === keys.length;
    const ariaSort = (key: SortKey) => (sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
    // The header controls are in the Tab order (after the list itself), so
    // sorting and "select all" work without a mouse.
    const sortHeader = (key: SortKey, label: string, className: string) => (
        <div role="columnheader" aria-sort={ariaSort(key)} className={className}>
            <button
                type="button"
                onClick={() => onSort(key)}
                className={cn('focus-ring inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-white/5 hover:text-zinc-100', sort.key === key && 'text-zinc-100')}
                aria-label={t('files.sortBy', { column: label })}
            >
                {label}
                {sort.key === key && (sort.direction === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
            </button>
        </div>
    );

    const focusedRowId = focusIndex >= 0 ? `${id}-row-${focusIndex}` : undefined;

    return (
        <div
            ref={gridRef}
            id={id}
            role="grid"
            tabIndex={0}
            aria-label={t('files.list.label', { path })}
            aria-rowcount={entries.length + 1}
            aria-multiselectable
            aria-activedescendant={focusedRowId}
            aria-describedby={`${id}-help`}
            onKeyDown={handleKeyDown}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onFocus={(event) => {
                if (event.target === event.currentTarget && selection.focus === null && keys.length) {
                    onSelectionChange({ ...selection, focus: keys[0] });
                }
            }}
            className="relative min-h-0 flex-1 overflow-auto outline-none scrollbar-thin [container-type:inline-size] focus-visible:shadow-[inset_0_0_0_1px_rgb(var(--c-brand-400)/0.35)]"
        >
            <span id={`${id}-help`} className="sr-only">{t('files.list.keyboardHelp')}</span>
            <div
                role="row"
                aria-rowindex={1}
                className={cn(COLUMNS, 'sticky top-0 z-10 items-center border-b border-white/5 bg-ink-850/95 text-xs font-medium text-zinc-400 backdrop-blur')}
                style={{ height: ROW_HEIGHT }}
            >
                <div role="columnheader" className="flex items-center justify-center">
                    <input
                        type="checkbox"
                        checked={allSelected}
                        disabled={!keys.length}
                        onChange={() => onSelectionChange(allSelected ? { ...selection, selected: new Set(), anchor: null } : selectAll(keys, selection))}
                        aria-label={t('files.columns.selectAll')}
                        className="focus-ring h-3.5 w-3.5 cursor-pointer accent-brand-500"
                    />
                </div>
                {sortHeader('name', t('files.columns.name'), 'min-w-0')}
                {sortHeader('size', t('files.columns.size'), 'pr-2 text-right')}
                {sortHeader('mtime', t('files.columns.modified'), cn(MODIFIED_CELL, 'pr-2 text-right'))}
                <div role="columnheader" className={cn(PERMISSIONS_CELL, 'pr-3 text-right')}>{t('files.columns.permissions')}</div>
                <div role="columnheader" className="pr-3 text-right"><span className="sr-only">{t('files.columns.actions')}</span></div>
            </div>
            {entries.length === 0 ? (
                emptyState
            ) : (
                // No text selection: Shift+click extends the row selection, not the text.
                <div role="rowgroup" className="relative select-none" style={{ height: virtualizer.getTotalSize() - ROW_HEIGHT }}>
                    {virtualizer.getVirtualItems().map((item) => (
                        <FileRow
                            key={keys[item.index]}
                            rowKey={keys[item.index]}
                            entry={entries[item.index]}
                            language={language}
                            index={item.index}
                            top={item.start - ROW_HEIGHT}
                            selected={selection.selected.has(keys[item.index])}
                            focused={item.index === focusIndex}
                            rowId={`${id}-row-${item.index}`}
                            maxEditBytes={maxEditBytes}
                            onToggle={onToggle}
                            onAction={onAction}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
