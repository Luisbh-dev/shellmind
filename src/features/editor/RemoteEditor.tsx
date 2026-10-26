import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, FileCode2, Lock, RefreshCw, Save, Unlock, WifiOff, X } from 'lucide-react';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Text } from '@codemirror/state';
import {
    crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter,
    highlightSpecialChars, keymap, lineNumbers, rectangularSelection
} from '@codemirror/view';
import type { FileVersion } from '@shared/files';
import { Button, IconButton, isOnScreen, Select, Spinner, useConfirm, useOverlay, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useLanguage, useT } from '@/i18n';
import type { FileClient } from '@/features/files/client';
import { isFileClientError } from '@/features/files/client';
import { formatBytes, formatDate } from '@/features/files/listing';
import { useReportUnsavedFile } from '@/features/files/pendingWork';
import { decodeText, encodeText, type DecodedText } from './textCodec';
import { detectLanguage, EDITOR_LANGUAGES, LANGUAGE_LABELS, loadLanguage, type EditorLanguage } from './languages';
import { shellmindEditorTheme } from './theme';
import { useResolvedTheme } from '@/features/appearance/store';

// The file session behind the editor: while it is not ready the text stays
// as it is (unsaved changes included) and saving waits for a reconnect.
export type EditorConnection = 'ready' | 'connecting' | 'lost';

export type RemoteEditorProps = {
    // The server the file is on: closing it while there are unsaved changes
    // asks first (features/files/pendingWork.ts).
    serverId: number;
    // May change (a reconnect opens a new session): the open text is kept.
    client: FileClient;
    // False while the panel holding the editor is hidden (another tab is
    // shown): the editor then keeps its text but handles no keys.
    active?: boolean;
    connection?: EditorConnection;
    onReconnect?: () => void;
    path: string;
    name: string;
    maxBytes: number;
    onClose: () => void;
    onDownload: () => void;
    onSaved?: () => void;
};

// What Tab may move to inside the editor dialog.
const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

// CodeMirror texts -> i18n keys (editor.cm.*).
const CM_PHRASES: Record<string, string> = {
    'Find': 'find',
    'Replace': 'replace',
    'next': 'next',
    'previous': 'previous',
    'all': 'all',
    'match case': 'matchCase',
    'regexp': 'regexp',
    'by word': 'byWord',
    'replace': 'replaceOne',
    'replace all': 'replaceAll',
    'close': 'close',
    'current match': 'currentMatch',
    'replaced $ matches': 'replacedMatches',
    'replaced match on line $': 'replacedMatchOnLine',
    'on line': 'onLine',
    'Go to line': 'goToLine',
    'go': 'go',
    'Folded lines': 'foldedLines',
    'Unfolded lines': 'unfoldedLines',
    'to': 'to',
    'folded code': 'foldedCode',
    'unfold': 'unfold',
    'Fold line': 'foldLine',
    'Unfold line': 'unfoldLine',
    'Completions': 'completions',
    'Selection deleted': 'selectionDeleted',
    'Control character': 'controlCharacter'
};

type Load =
    | { status: 'loading' }
    | { status: 'failed'; reason: 'binary' | 'notUtf8' | 'tooLarge' | 'error'; message?: string }
    | { status: 'ready'; decoded: DecodedText };

const isEditorLanguage = (value: string): value is EditorLanguage => (EDITOR_LANGUAGES as readonly string[]).includes(value);

// A remote text file in CodeMirror: Mod+S saves through the file protocol and
// is refused (then confirmed) when the file changed on the server since it
// was opened; closing with unsaved changes asks first. The editor is modal
// while shown: it is on the overlay stack (the app's shortcuts stay off), Tab
// stays inside it and Mod+S saves from anywhere in it.
export default function RemoteEditor({
    serverId, client, active = true, connection = 'ready', onReconnect, path, name, maxBytes, onClose, onDownload, onSaved
}: RemoteEditorProps) {
    const t = useT();
    const uiLanguage = useLanguage();
    const toast = useToast();
    const confirm = useConfirm();
    const titleId = useId();
    const [load, setLoad] = useState<Load>({ status: 'loading' });
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [readOnly, setReadOnly] = useState(false);
    const [syntax, setSyntax] = useState<EditorLanguage>(() => detectLanguage(path));
    const [cursor, setCursor] = useState({ line: 1, column: 1 });
    const theme = useResolvedTheme();
    const themeRef = useRef(theme);
    themeRef.current = theme;

    const dialogRef = useRef<HTMLDivElement>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const savedDoc = useRef<Text | null>(null);
    const version = useRef<FileVersion | null>(null);
    const slots = useRef({
        language: new Compartment(), readOnly: new Compartment(), attributes: new Compartment(), theme: new Compartment()
    });
    const saveRef = useRef<() => void>(() => undefined);
    const savingRef = useRef(false);
    const connected = connection === 'ready';
    useReportUnsavedFile(serverId, path, dirty);

    // Read once the session is there. A session that drops or is replaced
    // later never reloads the text (that would throw unsaved changes away).
    const needsLoad = load.status === 'loading';
    useEffect(() => {
        if (!needsLoad || !connected) return;
        let current = true;
        client.read(path, maxBytes).then(
            (result) => {
                if (!current) return;
                const bytes = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data);
                const decoded = decodeText(bytes);
                if (decoded === 'binary' || decoded === 'notUtf8') {
                    setLoad({ status: 'failed', reason: decoded });
                    return;
                }
                version.current = { size: result.stat.size, mtime: result.stat.mtime };
                setLoad({ status: 'ready', decoded });
            },
            (error: unknown) => {
                if (!current) return;
                if (isFileClientError(error, 'TOO_LARGE')) setLoad({ status: 'failed', reason: 'tooLarge' });
                else setLoad({ status: 'failed', reason: 'error', message: error instanceof Error ? error.message : String(error) });
            }
        );
        return () => { current = false; };
    }, [client, connected, needsLoad, path, maxBytes]);

    // The CodeMirror view, created once the text is there; later changes go
    // through compartments so the undo history and cursor survive.
    const decoded = load.status === 'ready' ? load.decoded : null;
    useEffect(() => {
        const host = hostRef.current;
        if (!decoded || !host) return;
        const { language, readOnly: readOnlySlot, attributes, theme: themeSlot } = slots.current;
        const state = EditorState.create({
            doc: decoded.text,
            extensions: [
                lineNumbers(),
                highlightActiveLineGutter(),
                highlightSpecialChars(),
                history(),
                foldGutter(),
                drawSelection(),
                dropCursor(),
                EditorState.allowMultipleSelections.of(true),
                indentOnInput(),
                bracketMatching(),
                closeBrackets(),
                autocompletion({ activateOnTyping: false }),
                rectangularSelection(),
                crosshairCursor(),
                highlightActiveLine(),
                highlightSelectionMatches(),
                search({ top: true }),
                // Mod+S is handled for the whole dialog (see below).
                keymap.of([
                    ...closeBracketsKeymap,
                    ...defaultKeymap,
                    ...searchKeymap,
                    ...historyKeymap,
                    ...foldKeymap,
                    indentWithTab
                ]),
                language.of([]),
                readOnlySlot.of([]),
                attributes.of([]),
                themeSlot.of(shellmindEditorTheme(themeRef.current)),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) setDirty(!savedDoc.current || !update.state.doc.eq(savedDoc.current));
                    if (update.docChanged || update.selectionSet) {
                        const head = update.state.selection.main.head;
                        const line = update.state.doc.lineAt(head);
                        setCursor({ line: line.number, column: head - line.from + 1 });
                    }
                })
            ]
        });
        const view = new EditorView({ state, parent: host });
        viewRef.current = view;
        savedDoc.current = state.doc;
        view.focus();
        return () => {
            view.destroy();
            viewRef.current = null;
        };
    }, [decoded]);

    // The light or dark theme, as it changes.
    useEffect(() => {
        viewRef.current?.dispatch({ effects: slots.current.theme.reconfigure(shellmindEditorTheme(theme)) });
    }, [theme]);

    // Texts that follow the UI language: the content's label and CodeMirror's own panels.
    useEffect(() => {
        const phrases = Object.fromEntries(Object.entries(CM_PHRASES).map(([phrase, key]) => [phrase, t(`editor.cm.${key}`)]));
        viewRef.current?.dispatch({
            effects: slots.current.attributes.reconfigure([
                EditorView.contentAttributes.of({ 'aria-label': t('editor.contentLabel', { name }) }),
                EditorState.phrases.of(phrases)
            ])
        });
    }, [t, name, decoded]);

    // Syntax highlighting, loaded on demand.
    useEffect(() => {
        let current = true;
        loadLanguage(syntax).then(
            (extension) => {
                if (current) viewRef.current?.dispatch({ effects: slots.current.language.reconfigure(extension) });
            },
            () => undefined
        );
        return () => { current = false; };
    }, [syntax, decoded]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: slots.current.readOnly.reconfigure(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [])
        });
    }, [readOnly, decoded]);

    // Leaving the page with unsaved changes asks the browser to confirm.
    useEffect(() => {
        if (!dirty) return;
        const guard = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener('beforeunload', guard);
        return () => window.removeEventListener('beforeunload', guard);
    }, [dirty]);

    const save = useCallback(async (force = false): Promise<void> => {
        const view = viewRef.current;
        if (!view || !decoded || readOnly) return;
        if (!connected) {
            toast.error(t('editor.saveFailed', { name }), t('editor.offline.cannotSave'));
            return;
        }
        const doc = view.state.doc;
        savingRef.current = true;
        setSaving(true);
        try {
            const result = await client.write(path, encodeText(doc.toString(), decoded), version.current, force);
            version.current = result.stat ? { size: result.stat.size, mtime: result.stat.mtime } : null;
            savedDoc.current = doc;
            setDirty(!view.state.doc.eq(doc));
            toast.success(t('editor.saved', { name }));
            onSaved?.();
        } catch (error) {
            if (isFileClientError(error, 'CONFLICT') && !force) {
                const current = error.current;
                const overwrite = await confirm({
                    title: t('editor.conflict.title'),
                    message: current
                        ? t('editor.conflict.message', { name, size: formatBytes(current.size, uiLanguage), date: formatDate(current.mtime, uiLanguage) })
                        : t('editor.conflict.gone', { name }),
                    confirmLabel: t('editor.conflict.confirm'),
                    tone: 'danger'
                });
                if (overwrite) await save(true);
                return;
            }
            toast.error(t('editor.saveFailed', { name }), error instanceof Error ? error.message : String(error));
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    }, [client, confirm, connected, decoded, name, onSaved, path, readOnly, t, toast, uiLanguage]);

    useEffect(() => {
        saveRef.current = () => {
            if (!savingRef.current) void save();
        };
    }, [save]);

    // Tab cycles within the dialog. CodeMirror keeps Tab for indenting
    // (it prevents the default), except after Escape.
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const trapFocus = (event: KeyboardEvent) => {
            if (event.key !== 'Tab' || event.defaultPrevented) return;
            const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.closest('.hidden'));
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        dialog.addEventListener('keydown', trapFocus);
        return () => dialog.removeEventListener('keydown', trapFocus);
    }, []);

    const requestClose = useCallback(async () => {
        if (dirty) {
            const discard = await confirm({
                title: t('editor.discard.title'),
                message: t('editor.discard.message', { name }),
                confirmLabel: t('editor.discard.confirm'),
                tone: 'danger'
            });
            if (!discard) {
                viewRef.current?.focus();
                return;
            }
        }
        onClose();
    }, [confirm, dirty, name, onClose, t]);

    // On the overlay stack while shown. Escape closes the editor, except
    // inside CodeMirror (the text and its panels): there it is CodeMirror's
    // (closing the search panel; Esc then Tab leaves the text). A dialog on
    // top of the editor gets Escape first. Not on screen (its server in the
    // background, the app locked behind a dialog), the key is not its own.
    const isTop = useOverlay(active, () => void requestClose(), {
        passEscape: (event) => !isOnScreen(dialogRef.current)
            || (event.target instanceof Node && (viewRef.current?.dom.contains(event.target) ?? false))
    });

    // Mod+S saves from anywhere in the editor (the text, the header, the
    // footer), and never opens the browser's "Save page" dialog; not while a
    // dialog is on top of the editor, nor while the editor is hidden (its tab,
    // its server in the background, or the app locked behind a dialog).
    useEffect(() => {
        if (!active) return undefined;
        const onKey = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
            const top = isTop();
            // Hidden with nothing of its own on top: the keys are meant for
            // something else. Its own confirmation (the app is inert
            // meanwhile) still keeps the browser's "Save page" away.
            if (top && !isOnScreen(dialogRef.current)) return;
            event.preventDefault();
            if (top) saveRef.current();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [active, isTop]);

    // Shown again (its tab was hidden): the text gets the focus back.
    useEffect(() => {
        if (active && !dialogRef.current?.contains(document.activeElement)) viewRef.current?.focus();
    }, [active]);

    const languageLabel = (language: EditorLanguage) => (language === 'plain' ? t('editor.plainText') : LANGUAGE_LABELS[language]);
    const failure = load.status !== 'failed' ? null
        : load.reason === 'binary' ? t('editor.binary')
            : load.reason === 'notUtf8' ? t('editor.notUtf8')
                : load.reason === 'tooLarge' ? t('editor.tooLarge', { size: formatBytes(maxBytes, uiLanguage) })
                    : load.message;

    return (
        <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-scrim/70 p-3 backdrop-blur-sm animate-fade-in sm:p-6">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="flex w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-800 shadow-panel animate-scale-in"
            >
                <header className="flex items-center gap-2 border-b border-white/5 px-4 py-2.5">
                    <FileCode2 className="h-4 w-4 shrink-0 text-brand-400" aria-hidden />
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="truncate text-sm font-semibold text-zinc-100">
                            {t('editor.title', { name })}
                            {dirty && <span className="ml-2 inline-block h-2 w-2 rounded-full bg-amber-400 align-middle" role="img" aria-label={t('editor.unsaved')} />}
                        </h2>
                        <p className="truncate font-mono text-[11px] text-zinc-500" title={path}>{path}</p>
                    </div>
                    {load.status === 'ready' && (
                        <>
                            <IconButton
                                label={readOnly ? t('editor.readOnlyOn') : t('editor.readOnlyOff')}
                                aria-pressed={readOnly}
                                active={readOnly}
                                onClick={() => setReadOnly((value) => !value)}
                            >
                                {readOnly ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                            </IconButton>
                            <Button variant="primary" size="sm" onClick={() => saveRef.current()} loading={saving} disabled={readOnly || !dirty || !connected}>
                                {!saving && <Save className="h-3.5 w-3.5" aria-hidden />}
                                {saving ? t('editor.saving') : t('editor.save')}
                            </Button>
                        </>
                    )}
                    <IconButton label={t('editor.close')} onClick={() => void requestClose()}>
                        <X className="h-4 w-4" />
                    </IconButton>
                </header>

                {!connected && (
                    <div role="status" className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/[0.08] px-4 py-2 text-xs text-amber-100">
                        <WifiOff className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden />
                        <span className="flex-1">{dirty ? t('editor.offline.unsaved') : t('editor.offline.message')}</span>
                        {connection === 'connecting' ? (
                            <span className="flex items-center gap-1.5 text-amber-200/80"><Spinner className="h-3.5 w-3.5" />{t('editor.offline.reconnecting')}</span>
                        ) : onReconnect && (
                            <Button variant="secondary" size="sm" className="h-7" onClick={onReconnect}>
                                <RefreshCw className="h-3.5 w-3.5" aria-hidden />{t('editor.offline.reconnect')}
                            </Button>
                        )}
                    </div>
                )}

                <div className="relative min-h-0 flex-1">
                    {load.status === 'loading' && (
                        <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-400" role="status">
                            <Spinner />{t('editor.loading', { name })}
                        </div>
                    )}
                    {load.status === 'failed' && (
                        <div className="flex h-full items-center justify-center p-6">
                            <div role="alert" className="max-w-md text-center">
                                <p className="text-sm font-medium text-zinc-100">{t('editor.openFailed', { name })}</p>
                                <p className="mt-1 text-sm text-zinc-400">{failure}</p>
                                {load.reason !== 'error' ? (
                                    <Button variant="secondary" size="sm" className="mt-4" onClick={onDownload}>
                                        <Download className="h-3.5 w-3.5" aria-hidden />{t('editor.download')}
                                    </Button>
                                ) : (
                                    <Button variant="secondary" size="sm" className="mt-4" onClick={() => setLoad({ status: 'loading' })}>
                                        <RefreshCw className="h-3.5 w-3.5" aria-hidden />{t('editor.retry')}
                                    </Button>
                                )}
                            </div>
                        </div>
                    )}
                    <div ref={hostRef} className={cn('h-full', load.status !== 'ready' && 'hidden')} />
                </div>

                {load.status === 'ready' && (
                    <footer className="flex items-center gap-3 border-t border-white/5 bg-ink-850 px-4 py-1.5 text-[11px] text-zinc-400">
                        <span>{t('editor.position', { line: cursor.line, column: cursor.column })}</span>
                        <span>{load.decoded.lineEnding === '\r\n' ? 'CRLF' : 'LF'}</span>
                        <span>{load.decoded.bom ? 'UTF-8 BOM' : 'UTF-8'}</span>
                        {readOnly && <span className="text-amber-300">{t('editor.readOnly')}</span>}
                        <span className="hidden flex-1 text-zinc-500 md:block">{t('editor.escapeHint')}</span>
                        <span className="flex-1 md:hidden" />
                        <div className="flex items-center gap-1.5">
                            <span aria-hidden>{t('editor.language')}</span>
                            <Select
                                value={syntax}
                                onChange={(value) => { if (isEditorLanguage(value)) setSyntax(value); }}
                                options={EDITOR_LANGUAGES.map((language) => ({ value: language, label: languageLabel(language) }))}
                                aria-label={t('editor.language')}
                                className="h-6 w-auto min-w-[9rem] rounded-md px-2 py-0 text-[11px]"
                            />
                        </div>
                    </footer>
                )}
            </div>
        </div>
    );
}
