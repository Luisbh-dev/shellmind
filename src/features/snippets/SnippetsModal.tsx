import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BookMarked, Plus, Search, Sparkles, X } from 'lucide-react';
import type { ServerSummary, Snippet } from '@shared/types';
import type { SnippetInput } from '@shared/snippets';
import { MULTIEXEC_SERVER_TYPES } from '@shared/multiexec';
import { Button, Input, Modal, Spinner, useConfirm, useToast } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { QUEUED_COMMAND_TTL_MS, useAppStore } from '@/store/appStore';
import type { GlobalActionProps } from '@/workspace/actions/types';
import { getServers } from '@/store/servers';
import { snippetsApi } from './api';
import { SnippetDetail, type SnippetRun } from './SnippetDetail';
import { snippetErrorText } from './errors';
import { useSnippetHandoff } from './handoff';
import { SnippetEditor } from './SnippetEditor';
import { StarterOffer } from './StarterOffer';
import { STARTER_SNIPPETS, starterInput } from './starters';
import { dismissStarters, forgetLastValues, saveLastValues, startersDismissed } from './storage';
import { copyText } from '@/lib/clipboard';
import { rememberTerminalSecrets } from '@/lib/terminalSecrets';
import { secretValues } from './placeholders';

type Pane =
    | { kind: 'view' }
    | { kind: 'edit'; snippet: Snippet | null; initial: SnippetInput }
    | { kind: 'starters'; firstRun: boolean };

const EMPTY_INPUT: SnippetInput = { name: '', command: '', description: null, tags: [], server_id: null };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function matches(snippet: Snippet, query: string): boolean {
    if (!query) return true;
    const needle = query.toLowerCase();
    return [snippet.name, snippet.description ?? '', snippet.command, ...snippet.tags].some((text) => text.toLowerCase().includes(needle));
}

export default function SnippetsModal({ onClose, server }: GlobalActionProps) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const openAction = useAppStore((state) => state.openAction);
    const listId = useId();
    const searchRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLUListElement>(null);

    const [snippets, setSnippets] = useState<Snippet[] | null>(null);
    const [servers, setServers] = useState<ServerSummary[]>([]);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [activeTags, setActiveTags] = useState<string[]>([]);
    const [allScopes, setAllScopes] = useState(false);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [pane, setPane] = useState<Pane>({ kind: 'view' });
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const load = useCallback(async (signal?: AbortSignal) => {
        try {
            const [list, serverList] = await Promise.all([snippetsApi.list(signal), getServers()]);
            setSnippets(list);
            setServers(serverList);
            setLoadError(null);
            return list;
        } catch (error) {
            if (signal?.aborted) return null;
            setLoadError(errorText(error));
            return null;
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        load(controller.signal).then((list) => {
            if (list && list.length === 0 && !startersDismissed()) setPane({ kind: 'starters', firstRun: true });
        });
        searchRef.current?.focus();
        return () => controller.abort();
    }, [load]);

    const serverNames = useMemo(() => new Map(servers.map((item) => [item.id, item.name])), [servers]);

    // Snippets usable here: global ones and the active server's, unless all are shown.
    const inScope = useMemo(() => (snippets ?? []).filter((snippet) =>
        allScopes || !server || snippet.server_id === null || snippet.server_id === server.id
    ), [snippets, allScopes, server]);

    const allTags = useMemo(() => {
        const byKey = new Map<string, string>();
        for (const snippet of inScope) for (const tag of snippet.tags) if (!byKey.has(tag.toLowerCase())) byKey.set(tag.toLowerCase(), tag);
        return [...byKey.values()].sort((a, b) => a.localeCompare(b));
    }, [inScope]);

    const visible = useMemo(() => inScope.filter((snippet) =>
        matches(snippet, query.trim())
        && activeTags.every((tag) => snippet.tags.some((own) => own.toLowerCase() === tag.toLowerCase()))
    ), [inScope, query, activeTags]);

    const selected = visible.find((snippet) => snippet.id === selectedId) ?? visible[0] ?? null;

    const toggleTag = (tag: string) => setActiveTags((current) =>
        current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]);

    const startEdit = (snippet: Snippet | null, initial: SnippetInput) => {
        setSaveError(null);
        setPane({ kind: 'edit', snippet, initial });
    };

    const save = async (input: SnippetInput) => {
        if (pane.kind !== 'edit') return;
        setSaving(true);
        setSaveError(null);
        try {
            const saved = pane.snippet ? await snippetsApi.update(pane.snippet.id, input) : await snippetsApi.create(input);
            await load();
            // Keep the saved snippet visible even if the filters would hide it.
            setQuery('');
            setActiveTags([]);
            if (saved.server_id !== null && server && saved.server_id !== server.id) setAllScopes(true);
            setSelectedId(saved.id);
            setPane({ kind: 'view' });
            toast.success(pane.snippet ? t('snippets.toasts.updated') : t('snippets.toasts.created'), saved.name);
        } catch (error) {
            setSaveError(snippetErrorText(error, t));
        } finally {
            setSaving(false);
        }
    };

    const remove = async (snippet: Snippet) => {
        const ok = await confirm({
            title: t('snippets.delete.title'),
            message: t('snippets.delete.message', { name: snippet.name }),
            confirmLabel: t('snippets.delete.confirm'),
            tone: 'danger'
        });
        if (!ok) return;
        try {
            await snippetsApi.remove(snippet.id);
            forgetLastValues(snippet.id);
            await load();
            toast.success(t('snippets.toasts.deleted'), snippet.name);
        } catch (error) {
            toast.error(t('snippets.toasts.deleteFailed'), errorText(error));
        }
    };

    const importStarters = async (keys: string[]) => {
        setSaving(true);
        try {
            const inputs = STARTER_SNIPPETS.filter((starter) => keys.includes(starter.key)).map((starter) => starterInput(starter, t));
            const result = await snippetsApi.importMany(inputs);
            dismissStarters();
            await load();
            setPane({ kind: 'view' });
            toast.success(t('snippets.toasts.imported', { count: result.created }),
                result.skipped ? t('snippets.toasts.skipped', { count: result.skipped }) : undefined);
        } catch (error) {
            toast.error(t('snippets.toasts.importFailed'), snippetErrorText(error, t));
        } finally {
            setSaving(false);
        }
    };

    // Recorded (terminal history, audit log) with its secret values masked,
    // and the terminal's text is masked with them before the AI chat reads it
    // (the shell echoes them). With a secret in it the line starts with a
    // space, which keeps it out of the shell's own history where
    // HISTCONTROL=ignorespace (the default of Debian and Ubuntu) or zsh's
    // HIST_IGNORE_SPACE applies.
    const runInTerminal = (snippet: Snippet) => ({ command, display, values, secret }: SnippetRun) => {
        if (!server) return;
        saveLastValues(snippet.id, values, new Set(secret));
        const { connections, queueCommand } = useAppStore.getState();
        // Not connected: the command waits for the session (and expires, FE-07).
        const connected = connections[server.id]?.state === 'connected';
        const hasSecret = display !== command;
        rememberTerminalSecrets(server.id, secretValues(values, new Set(secret)));
        queueCommand(server.id, hasSecret ? ` ${command}` : command, 'snippet', { display });
        toast.success(
            connected
                ? t('snippets.toasts.sent', { server: server.name })
                : t('snippets.toasts.queued', { server: server.name, minutes: Math.round(QUEUED_COMMAND_TTL_MS / 60_000) }),
            snippet.name
        );
        onClose();
    };

    // A scoped snippet goes with its own server selected (multi-exec keeps it
    // there). The template goes with its values: multi-exec fills it in on
    // the backend, which records it with the secret values masked.
    const runOnMany = (snippet: Snippet) => ({ values, secret, marks }: SnippetRun) => {
        saveLastValues(snippet.id, values, new Set(secret));
        useSnippetHandoff.getState().prepare({
            command: snippet.command,
            values,
            marks,
            snippet: { id: snippet.id, name: snippet.name, serverId: snippet.server_id },
            serverIds: snippet.server_id === null ? undefined : [snippet.server_id]
        });
        openAction('multiexec');
    };

    // Multi-exec reaches SSH servers only.
    const canRunOnMany = (snippet: Snippet) => {
        if (snippet.server_id === null) return true;
        const scope = servers.find((item) => item.id === snippet.server_id);
        return Boolean(scope && MULTIEXEC_SERVER_TYPES.includes(scope.type));
    };

    // Most likely pasted into the active server's terminal: masked there too.
    const copy = (snippet: Snippet) => async ({ command, values, secret }: SnippetRun) => {
        saveLastValues(snippet.id, values, new Set(secret));
        if (server) rememberTerminalSecrets(server.id, secretValues(values, new Set(secret)));
        try {
            await copyText(command);
            toast.success(t('snippets.toasts.copied'));
        } catch {
            toast.error(t('snippets.toasts.copyFailed'));
        }
    };

    // Arrow keys move through the list (focus follows the selection).
    const onListKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
        if (!visible.length) return;
        event.preventDefault();
        const index = selected ? visible.indexOf(selected) : -1;
        const next = event.key === 'Home' ? 0
            : event.key === 'End' ? visible.length - 1
                : Math.min(visible.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
        setSelectedId(visible[next].id);
        setPane({ kind: 'view' });
        listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-snippet]')[next]?.focus();
    };

    const scopeLabel = (snippet: Snippet) => (snippet.server_id === null ? null : serverNames.get(snippet.server_id) ?? `#${snippet.server_id}`);

    const renderPane = () => {
        if (pane.kind === 'edit') {
            return (
                <SnippetEditor
                    key={pane.snippet?.id ?? 'new'}
                    initial={pane.initial}
                    isNew={!pane.snippet}
                    servers={servers}
                    saving={saving}
                    error={saveError}
                    onSave={save}
                    onCancel={() => setPane({ kind: 'view' })}
                />
            );
        }
        if (pane.kind === 'starters') {
            return (
                <StarterOffer
                    importing={saving}
                    firstRun={pane.firstRun}
                    onImport={importStarters}
                    onDismiss={() => {
                        if (pane.firstRun) dismissStarters();
                        setPane({ kind: 'view' });
                    }}
                />
            );
        }
        if (loadError) {
            return (
                <div role="alert" className="space-y-3 text-sm text-rose-200">
                    <p>{t('snippets.loadFailed')}</p>
                    <p className="text-xs text-rose-300/80">{loadError}</p>
                    <Button size="sm" onClick={() => load()}>{t('snippets.retry')}</Button>
                </div>
            );
        }
        if (snippets === null) {
            return <div className="flex h-full items-center justify-center text-zinc-400"><Spinner /><span className="sr-only">{t('snippets.loading')}</span></div>;
        }
        if (!selected) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                    <BookMarked className="h-8 w-8 text-zinc-500" aria-hidden="true" />
                    <p className="text-sm text-zinc-400">{snippets.length ? t('snippets.empty.noMatch') : t('snippets.empty.library')}</p>
                    <div className="flex gap-2">
                        <Button size="sm" variant="primary" onClick={() => startEdit(null, EMPTY_INPUT)}><Plus className="h-3.5 w-3.5" aria-hidden="true" />{t('snippets.actions.new')}</Button>
                        {!snippets.length && (
                            <Button size="sm" onClick={() => setPane({ kind: 'starters', firstRun: false })}><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{t('snippets.actions.starters')}</Button>
                        )}
                    </div>
                </div>
            );
        }
        return (
            <SnippetDetail
                key={selected.id}
                snippet={selected}
                server={server}
                scopeName={scopeLabel(selected)}
                canRunOnMany={canRunOnMany(selected)}
                onEdit={() => startEdit(selected, selected)}
                onDuplicate={() => startEdit(null, { ...selected, name: t('snippets.copyName', { name: selected.name }).slice(0, 120) })}
                onDelete={() => remove(selected)}
                onRunInTerminal={runInTerminal(selected)}
                onRunOnMany={runOnMany(selected)}
                onCopy={copy(selected)}
            />
        );
    };

    return (
        <Modal
            open
            onClose={onClose}
            title={t('snippets.title')}
            description={t('snippets.subtitle')}
            icon={<BookMarked className="h-4 w-4" />}
            widthClass="max-w-5xl"
        >
            <div className="-mx-5 -my-4 flex h-[min(72vh,680px)] min-h-[420px]">
                <div className="flex w-60 shrink-0 flex-col border-r border-white/5 md:w-72">
                    <div className="space-y-2 border-b border-white/5 p-3">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                            <Input
                                ref={searchRef}
                                type="search"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t('snippets.search')}
                                aria-label={t('snippets.search')}
                                aria-controls={listId}
                                className="h-8 py-1 pl-8 text-xs"
                            />
                        </div>
                        {server && (
                            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
                                <input type="checkbox" checked={allScopes} onChange={(event) => setAllScopes(event.target.checked)} className="h-3.5 w-3.5 accent-brand-500" />
                                {t('snippets.showAllScopes')}
                            </label>
                        )}
                        {allTags.length > 0 && (
                            <div role="group" aria-label={t('snippets.tagFilter')} className="flex max-h-20 flex-wrap gap-1 overflow-y-auto scrollbar-thin">
                                {allTags.map((tag) => {
                                    const active = activeTags.includes(tag);
                                    return (
                                        <button
                                            key={tag}
                                            type="button"
                                            aria-pressed={active}
                                            onClick={() => toggleTag(tag)}
                                            className={cn(
                                                'rounded-md border px-1.5 py-0.5 text-[11px] transition-colors focus-ring',
                                                active ? 'border-brand-500/50 bg-brand-500/15 text-brand-200' : 'border-white/10 text-zinc-400 hover:text-zinc-200'
                                            )}
                                        >
                                            {tag}
                                        </button>
                                    );
                                })}
                                {activeTags.length > 0 && (
                                    <button type="button" onClick={() => setActiveTags([])} className="inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] text-zinc-400 hover:text-zinc-200 focus-ring">
                                        <X className="h-3 w-3" aria-hidden="true" />{t('snippets.clearTags')}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    <ul
                        id={listId}
                        ref={listRef}
                        aria-label={t('snippets.listLabel')}
                        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2 scrollbar-thin"
                    >
                        {visible.map((snippet) => {
                            const isSelected = selected?.id === snippet.id && pane.kind === 'view';
                            const scope = scopeLabel(snippet);
                            return (
                                <li key={snippet.id}>
                                    <button
                                        type="button"
                                        data-snippet
                                        aria-current={isSelected || undefined}
                                        tabIndex={selected?.id === snippet.id ? 0 : -1}
                                        onKeyDown={onListKeyDown}
                                        onClick={() => {
                                            setSelectedId(snippet.id);
                                            setPane({ kind: 'view' });
                                        }}
                                        className={cn(
                                            'w-full rounded-lg px-2.5 py-2 text-left transition-colors focus-ring',
                                            isSelected ? 'bg-brand-500/10 ring-1 ring-brand-500/30' : 'hover:bg-white/[0.04]'
                                        )}
                                    >
                                        <span className="block truncate text-sm font-medium text-zinc-100">{snippet.name}</span>
                                        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-400">{snippet.command.split('\n')[0]}</span>
                                        {(scope || snippet.tags.length > 0) && (
                                            <span className="mt-1 flex flex-wrap gap-1">
                                                {scope && <span className="rounded bg-amber-500/10 px-1 text-[10px] text-amber-200">{scope}</span>}
                                                {snippet.tags.slice(0, 3).map((tag) => (
                                                    <span key={tag} className="rounded bg-white/[0.06] px-1 text-[10px] text-zinc-400">{tag}</span>
                                                ))}
                                            </span>
                                        )}
                                    </button>
                                </li>
                            );
                        })}
                        {snippets !== null && visible.length === 0 && (
                            <li className="px-2 py-6 text-center text-xs text-zinc-500">{snippets.length ? t('snippets.empty.noMatch') : t('snippets.empty.short')}</li>
                        )}
                    </ul>

                    <div className="flex gap-2 border-t border-white/5 p-3">
                        <Button size="sm" variant="primary" className="flex-1" onClick={() => startEdit(null, EMPTY_INPUT)}>
                            <Plus className="h-3.5 w-3.5" aria-hidden="true" />{t('snippets.actions.new')}
                        </Button>
                        <Button size="sm" variant="subtle" onClick={() => setPane({ kind: 'starters', firstRun: false })} title={t('snippets.actions.starters')} aria-label={t('snippets.actions.starters')}>
                            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                    </div>
                </div>

                <div className="min-w-0 flex-1 overflow-y-auto p-5 scrollbar-thin">{renderPane()}</div>
            </div>
        </Modal>
    );
}
