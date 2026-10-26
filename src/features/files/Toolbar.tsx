import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, Eye, EyeOff, FolderPlus, HardDrive, Home, Pencil, RefreshCw, Search, Upload, X } from 'lucide-react';
import type { FileProtocol } from '@shared/files';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';
import { breadcrumbs, resolveInputPath } from './listing';

type PathBarProps = {
    path: string;
    home: string;
    protocol: FileProtocol;
    host: string;
    editing: boolean;
    onEditingChange: (editing: boolean) => void;
    onNavigate: (path: string) => void;
};

function PathBar({ path, home, protocol, host, editing, onEditingChange, onNavigate }: PathBarProps) {
    const t = useT();
    const [draft, setDraft] = useState(path);
    const inputRef = useRef<HTMLInputElement>(null);
    const crumbsRef = useRef<HTMLOListElement>(null);
    const crumbs = breadcrumbs(path);

    useEffect(() => {
        if (editing) {
            setDraft(path);
            requestAnimationFrame(() => inputRef.current?.select());
        }
    }, [editing, path]);

    // Long paths: keep the current folder in view, also when the bar changes
    // width (the chat or the sidebar resizes the panel, not only the window)
    // and when the crumbs come back after editing the path.
    useEffect(() => {
        const list = crumbsRef.current;
        if (!list) return;
        const pin = () => { list.scrollLeft = list.scrollWidth; };
        pin();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(pin);
        observer.observe(list);
        return () => observer.disconnect();
    }, [path, editing]);

    return (
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-white/5 bg-ink-900/60 pl-2 pr-1">
            <span className="hidden shrink-0 items-center gap-1.5 text-zinc-500 [@container(min-width:46rem)]:flex" title={`${protocol}://${host}`}>
                <HardDrive className="h-3.5 w-3.5" aria-hidden />
                <span className="max-w-[9rem] truncate font-mono text-[11px]">{protocol}://{host}</span>
            </span>
            {editing ? (
                <input
                    ref={inputRef}
                    value={draft}
                    aria-label={t('files.toolbar.pathLabel')}
                    spellCheck={false}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => onEditingChange(false)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            onEditingChange(false);
                            onNavigate(resolveInputPath(draft, path, home));
                        } else if (event.key === 'Escape') {
                            event.preventDefault();
                            onEditingChange(false);
                        }
                    }}
                    className="h-8 min-w-0 flex-1 bg-transparent px-1 font-mono text-xs text-zinc-100 outline-none"
                />
            ) : (
                <nav aria-label={t('files.toolbar.breadcrumb')} className="min-w-0 flex-1">
                    <ol ref={crumbsRef} className="flex h-8 items-center gap-0.5 overflow-x-auto whitespace-nowrap scrollbar-hide">
                        <li className="shrink-0">
                            <button
                                type="button"
                                onClick={() => onNavigate('/')}
                                className="focus-ring rounded px-1.5 py-0.5 font-mono text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                                aria-label={t('files.toolbar.root')}
                                aria-current={crumbs.length === 0 ? 'location' : undefined}
                            >
                                /
                            </button>
                        </li>
                        {crumbs.map((crumb, index) => {
                            const last = index === crumbs.length - 1;
                            return (
                                <li key={crumb.path} className="flex shrink-0 items-center">
                                    <ChevronRight className="h-3.5 w-3.5 text-zinc-600" aria-hidden />
                                    <button
                                        type="button"
                                        onClick={() => onNavigate(crumb.path)}
                                        aria-current={last ? 'location' : undefined}
                                        className={cn('focus-ring rounded px-1 py-0.5 text-xs hover:bg-white/5 hover:text-zinc-100', last ? 'font-medium text-zinc-100' : 'text-zinc-400')}
                                    >
                                        {crumb.name}
                                    </button>
                                </li>
                            );
                        })}
                    </ol>
                </nav>
            )}
            {!editing && (
                <IconButton size="sm" label={t('files.toolbar.editPath')} onClick={() => onEditingChange(true)} className="border-transparent bg-transparent">
                    <Pencil className="h-3.5 w-3.5" />
                </IconButton>
            )}
        </div>
    );
}

export type ToolbarProps = {
    path: string;
    home: string;
    protocol: FileProtocol;
    host: string;
    busy: boolean;
    disabled: boolean;
    editingPath: boolean;
    onEditingPathChange: (editing: boolean) => void;
    filter: string;
    onFilterChange: (filter: string) => void;
    showHidden: boolean;
    onShowHiddenChange: (show: boolean) => void;
    onNavigate: (path: string) => void;
    onUp: () => void;
    onRefresh: () => void;
    onNewFolder: () => void;
    onUpload: (files: File[]) => void;
};

export function Toolbar(props: ToolbarProps) {
    const t = useT();
    const fileInput = useRef<HTMLInputElement>(null);
    const { path, home, disabled } = props;

    // The bar is a container: in a narrow panel the filter and the protocol
    // label give way, so the path keeps its room.
    return (
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-white/5 bg-ink-850/60 px-2.5 [container-type:inline-size]">
            <IconButton label={t('files.toolbar.up')} onClick={props.onUp} disabled={disabled || path === '/'}>
                <ArrowUp className="h-4 w-4" />
            </IconButton>
            <IconButton label={t('files.toolbar.home')} onClick={() => props.onNavigate(home)} disabled={disabled}>
                <Home className="h-4 w-4" />
            </IconButton>
            <PathBar
                path={path}
                home={home}
                protocol={props.protocol}
                host={props.host}
                editing={props.editingPath}
                onEditingChange={props.onEditingPathChange}
                onNavigate={props.onNavigate}
            />
            <div className="relative hidden w-36 shrink-0 [@container(min-width:34rem)]:block [@container(min-width:36rem)]:w-44">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden />
                <input
                    type="search"
                    value={props.filter}
                    onChange={(event) => props.onFilterChange(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Escape') props.onFilterChange(''); }}
                    placeholder={t('files.toolbar.filter')}
                    aria-label={t('files.toolbar.filter')}
                    disabled={disabled}
                    className="h-8 w-full rounded-lg border border-white/5 bg-ink-900/60 pl-7 pr-7 text-xs text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-brand-500/60 [&::-webkit-search-cancel-button]:hidden"
                />
                {props.filter && (
                    <button
                        type="button"
                        onClick={() => props.onFilterChange('')}
                        className="focus-ring absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-500 hover:text-zinc-200"
                        aria-label={t('files.toolbar.clearFilter')}
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>
            <IconButton
                label={props.showHidden ? t('files.toolbar.hideHidden') : t('files.toolbar.showHidden')}
                aria-pressed={props.showHidden}
                active={props.showHidden}
                onClick={() => props.onShowHiddenChange(!props.showHidden)}
                disabled={disabled}
            >
                {props.showHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </IconButton>
            <IconButton label={t('files.toolbar.refresh')} onClick={props.onRefresh} disabled={disabled}>
                <RefreshCw className={cn('h-4 w-4', props.busy && 'animate-spin')} />
            </IconButton>
            <IconButton label={t('files.toolbar.newFolder')} onClick={props.onNewFolder} disabled={disabled}>
                <FolderPlus className="h-4 w-4" />
            </IconButton>
            <IconButton label={t('files.toolbar.upload')} onClick={() => fileInput.current?.click()} disabled={disabled}>
                <Upload className="h-4 w-4" />
            </IconButton>
            <input
                ref={fileInput}
                type="file"
                multiple
                tabIndex={-1}
                aria-hidden
                className="hidden"
                onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    if (files.length) props.onUpload(files);
                }}
            />
        </div>
    );
}
