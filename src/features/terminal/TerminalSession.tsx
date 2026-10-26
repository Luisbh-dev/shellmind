import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { findDangerousCommand, type DangerMatch } from '@shared/commandSafety';
import type { AnyTerminalAttach, HostKeyInfo } from '@shared/protocol';
import { cliPresetInfo } from '@shared/shells';
import type { ISearchOptions } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import { useConfirm } from '@/components/ui/Confirm';
import { useToast } from '@/components/ui/Toast';
import { t as translate, useT } from '@/i18n';
import { noteTerminalCommand, reportIssueLine } from '@/lib/terminalIssues';
import { useAppStore, type CommandSource, type QueuedCommand } from '@/store/appStore';
import type { TerminalSize } from '@/store/terminalOutput';
import { actionRegistry, isMacPlatform } from '@/workspace/actions/registry';
import type { WorkspaceServer } from '@/workspace/types';
import { auditBroadcastCommand, auditSentCommand } from './audit';
import {
    broadcastKey, fanOutInput, noteBufferChange, noteCommandSent, noteScreenChange, previewTargets, registerReceiver, setLeader
} from './broadcast';
import { isAutoRunStep, reportUndelivered, takeQueuedWhere } from './commandDelivery';
import { CommandTracker, isFocusReport, type PendingLine, type TerminalScreen } from './commandTracker';
import { ContextMenu, type ContextMenuAction } from './ContextMenu';
import { deliveryFor, lineCount, sessionShell, terminalInput, typingRisk, type TypingRisk } from './delivery';
import { ErrorMarkers } from './errorMarkers';
import { HintsPanel } from './HintsPanel';
import { hintGroupsFor, type Hint } from './hints';
import { useCommandHistory, type FavoriteEntry, type HistoryEntry } from './history';
import { HistoryPanel } from './HistoryPanel';
import { terminalKeyAction } from './keyboard';
import { dangerReasonKey, listTerminals } from './names';
import { SearchPanel, type SearchStats } from './SearchPanel';
import { useTerminalPrefs } from './preferences';
import { ContainerHeldBanner, HeldCommandsBanner, HostKeyBanner, SessionBanner } from './SessionBanner';
import { SessionToolbar, type SessionToolbarHandle, type TerminalPanelKind, type ToolbarShortcuts } from './SessionToolbar';
import { isReadingInput, ShellReadiness } from './shellReady';
import { useTerminalSocket, type SessionEvents } from './useTerminalSocket';
import { useXterm } from './useXterm';
import { terminalOverlayColors } from '@/features/appearance/terminalThemes';
import { useTerminalAppearance } from '@/features/appearance/useTerminalAppearance';
import { copyText, readClipboardText } from '@/lib/clipboard';

// Stable callbacks from the panel (they read the latest props through refs).
export type SessionCallbacks = {
    // Output of the focused tab (`sessionId` tells which one it is) and the
    // tab's size.
    onOutput: (data: string, sessionId: string, size: TerminalSize) => void;
    // The tab got the focus; `screen` is what it shows, up to the cursor.
    onFocused: (sessionId: string, screen: string) => void;
    onOsDetected: (os: string) => void;
};

type Props = {
    server: WorkspaceServer;
    sessionId: string;
    // The server's focused tab: it receives queued commands and its output
    // feeds the chat.
    focused: boolean;
    // On screen (focused tab of the visible panel).
    visible: boolean;
    // Where the focused tab renders its toolbar (the panel's header).
    toolbarSlot: HTMLElement | null;
    callbacks: SessionCallbacks;
    // The tab is a shell inside this container of the server (W8-T2: or of a pod).
    attach?: AnyTerminalAttach;
};

const SEARCH_OPTIONS: ISearchOptions = {
    caseSensitive: false,
    wholeWord: false,
    regex: false
};

const NOTICE_MS = 2200;
const SNAPSHOT_LINES = 140;
const SNAPSHOT_CHARS = 6000;

// What the terminal says when it did not type an Auto-Run step.
const AUTO_RUN_REFUSED = {
    'full-screen': 'terminal.notices.autoRunFullScreen',
    'no-prompt': 'terminal.notices.autoRunNoPrompt',
    'not-connected': 'terminal.notices.autoRunNotConnected',
    'container-shell': 'terminal.notices.autoRunContainer'
} as const;

// What the terminal shows up to the cursor, as plain text (wrapped rows
// joined): where the output of a tab that just got the focus continues.
function screenUpToCursor(term: Terminal): string {
    const buffer = term.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    let text = '';
    for (let row = Math.max(0, cursorRow - SNAPSHOT_LINES); row <= cursorRow; row++) {
        const line = buffer.getLine(row);
        if (!line) continue;
        const content = row === cursorRow ? line.translateToString(false).slice(0, buffer.cursorX) : line.translateToString(true);
        // Empty rows above the first text are dropped.
        text += (text && !line.isWrapped ? '\n' : '') + content;
    }
    return text.slice(-SNAPSHOT_CHARS);
}

// The line the cursor is on (wrapped rows joined), up to the cursor: the
// prompt a command sent now is typed at.
function cursorLine(term: Terminal): string {
    const buffer = term.buffer.active;
    let row = buffer.baseY + buffer.cursorY;
    let text = buffer.getLine(row)?.translateToString(false).slice(0, buffer.cursorX) ?? '';
    while (row > 0 && buffer.getLine(row)?.isWrapped) {
        row -= 1;
        text = (buffer.getLine(row)?.translateToString(false) ?? '') + text;
    }
    return text;
}

// The line the cursor is on (wrapped rows joined) to the end of the cursor's
// row: a resize may leave the cursor before the end of a prompt. The rows
// below are not read: after a reflow they may hold other text.
function cursorRowLine(term: Terminal): string {
    const buffer = term.buffer.active;
    const last = buffer.baseY + buffer.cursorY;
    let first = last;
    while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1;
    let text = '';
    for (let row = first; row <= last; row++) text += buffer.getLine(row)?.translateToString(row === last) ?? '';
    return text;
}

// Several tabs of one server may report the same newly trusted key.
const announcedKeys = new Map<string, number>();
function announceTrustedKey(info: HostKeyInfo, toast: ReturnType<typeof useToast>): void {
    const key = `${info.host}:${info.port}:${info.fingerprint}`;
    const now = Date.now();
    if (now - (announcedKeys.get(key) ?? 0) < 10_000) return;
    announcedKeys.set(key, now);
    toast.info(translate('terminal.hostKey.trustedTitle'), translate('terminal.hostKey.trustedText', { ...info }));
}

// Plain Ctrl+letter belongs to the terminal program (readline, vim, nano)
// even when the app binds it; on macOS Cmd shortcuts never reach the remote.
function belongsToProgram(event: KeyboardEvent, mac: boolean): boolean {
    return !mac && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && /^[a-z]$/i.test(event.key);
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Input that did not come from the keys one at a time: a paste (bracketed,
// or text with line breaks in it).
function looksLikePaste(data: string): boolean {
    return data.includes(PASTE_START) || (data.length > 1 && !data.startsWith('\x1b') && /[\r\n]/.test(data));
}

const pastedText = (data: string) => data.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '').replace(/\r\n?/g, '\n');

// Enter on a line typed into several terminals waits (at most ENTER_WAIT_MS)
// for the screen to show a line that arrow keys or Tab changed, until it
// printed nothing for ENTER_QUIET_MS.
const ENTER_WAIT_MS = 1500;
const ENTER_QUIET_MS = 80;

// History expansion (!!, !-2, !$, !word, ^old^new): the shell runs a line the
// screen does not show.
const HISTORY_EXPANSION = /(?:^|[\s;&|(`])!(?:!|-?\d|[$^*]|[A-Za-z?#])|^\^[^^\s]+\^/;

// Why Enter on a line going to several terminals asks first: a destructive
// command, or a line that could not be checked.
type EnterVerdict = { line: string; danger: DangerMatch | null; unchecked: 'screen' | 'history' | null };

// Without arrow keys or Tab the keys typed are the line (its echo may lag
// behind them); with them, only the screen knows it, once it caught up. Both
// are checked when both are known: a line that cannot be read is never
// taken as harmless.
function enterVerdict(pending: PendingLine | null, scopedBin: string | null): EnterVerdict | null {
    if (!pending) return null;
    const texts = [...new Set([pending.typed, pending.shown].filter(Boolean))];
    for (const text of texts) {
        const danger = findDangerousCommand(text, { scopedBin });
        if (danger) return { line: danger.line, danger, unchecked: null };
    }
    const line = (pending.edited ? pending.shown : pending.typed) || pending.shown || pending.typed;
    if (pending.edited && !pending.caughtUp) return { line, danger: null, unchecked: 'screen' };
    if (texts.some((text) => HISTORY_EXPANSION.test(text))) return { line, danger: null, unchecked: 'history' };
    return null;
}

function useLatest<T>(value: T) {
    const ref = useRef(value);
    useEffect(() => {
        ref.current = value;
    });
    return ref;
}

function TerminalSession({ server, sessionId, focused, visible, toolbarSlot, callbacks, attach }: Props) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const containerRef = useRef<HTMLDivElement>(null);
    const toolbarRef = useRef<SessionToolbarHandle>(null);
    const appearance = useTerminalAppearance();
    const overlayColors = terminalOverlayColors(appearance.scheme.kind);
    const overlayColorsRef = useLatest(overlayColors);
    const screenReaderMode = useTerminalPrefs((prefs) => prefs.screenReaderMode);
    const xterm = useXterm(containerRef, { visible, appearance, screenReaderMode });
    const term = xterm?.term ?? null;

    const [panel, setPanel] = useState<TerminalPanelKind | null>(null);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const [notice, setNotice] = useState('');
    const [searchValue, setSearchValue] = useState('');
    const [searchStats, setSearchStats] = useState<SearchStats>({ index: -1, count: 0 });
    const [bannerHidden, setBannerHidden] = useState(false);
    const [trusting, setTrusting] = useState(false);
    const trackerRef = useRef<CommandTracker | null>(null);
    const markersRef = useRef<ErrorMarkers | null>(null);
    const readinessRef = useRef<ShellReadiness | null>(null);
    const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const mac = isMacPlatform();
    const shortcuts: ToolbarShortcuts = mac
        ? { copy: '⌘C', paste: '⌘V', search: '⌘F' }
        : { copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V', search: 'Ctrl+Shift+F' };
    const serverId = server.id;
    // The tab as broadcast input knows it (broadcast.ts).
    const key = broadcastKey(serverId, sessionId);
    const scopedBin = server.type === 'local' ? cliPresetInfo(server.cli_preset)?.bin ?? null : null;

    const setSessionState = useAppStore((state) => state.setTerminalSessionState);
    const requestChat = useAppStore((state) => state.requestChat);
    const queuedCount = useAppStore((state) => (focused ? state.pendingCommands[serverId]?.length ?? 0 : 0));
    const focusedRef = useLatest(focused);

    const showNotice = useCallback((message: string) => {
        setNotice(message);
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setNotice(''), NOTICE_MS);
    }, []);
    useEffect(() => () => {
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
    }, []);

    const recordCommand = useCallback((command: string, source: CommandSource) => {
        useCommandHistory.getState().record(serverId, command, source);
    }, [serverId]);

    // A command is about to run (Enter, or sent by the app): what follows is
    // its output, for the error markers and the chat's issue detection.
    const noteCommand = useCallback((command: string) => {
        markersRef.current?.noteCommand(command);
        if (focusedRef.current) noteTerminalCommand(serverId, command);
    }, [serverId, focusedRef]);

    // An Enter waiting for the screen to settle (screenSettled) hears of output.
    const settleRef = useRef<(() => void) | null>(null);

    const events = useMemo<SessionEvents>(() => ({
        onOutput: (data, size) => {
            trackerRef.current?.output();
            markersRef.current?.schedule();
            readinessRef.current?.output();
            // Its prompt may have changed (a password prompt, a program exited).
            noteScreenChange(key, data);
            settleRef.current?.();
            if (focusedRef.current) callbacks.onOutput(data, sessionId, size);
        },
        onOsDetected: (os) => {
            if (focusedRef.current) callbacks.onOsDetected(os);
        },
        onHostKeyTrusted: (info) => announceTrustedKey(info, toast)
    }), [callbacks, toast, focusedRef, sessionId, key]);

    const { state, error, errorDetail, offline, mismatch, reconnect, send, canSend, trustHostKey } = useTerminalSocket(server, xterm, events, attach);

    // ---- Broadcast input ---------------------------------------------------

    // Typed here as if by the user; the line went to `size` terminals.
    const typeHere = useCallback((data: string, size: number) => {
        trackerRef.current?.markBroadcast(size);
        trackerRef.current?.input(data);
        send(data);
    }, [send]);

    useEffect(() => {
        if (!term) return undefined;
        return registerReceiver(key, {
            screen: () => {
                const buffer = term.buffer.active;
                return {
                    connected: canSend(),
                    alternate: buffer.type === 'alternate',
                    cursorLine: cursorLine(term),
                    line: cursorRowLine(term),
                    row: buffer.baseY + buffer.cursorY,
                    bracketedPaste: term.modes.bracketedPasteMode,
                    lineStarted: trackerRef.current?.hasLine() ?? false
                };
            },
            deliver: typeHere,
            markBroadcast: (size) => trackerRef.current?.markBroadcast(size)
        });
    }, [term, key, canSend, typeHere]);

    // The others are compared with the terminal the user is in.
    useEffect(() => {
        if (focused && visible) setLeader(key);
    }, [focused, visible, key]);

    // A paste goes to the other terminals (`targets`: their keys) only once
    // the user agrees.
    const confirmPaste = useCallback((targets: readonly string[], text: string): Promise<boolean> => {
        const count = targets.length + 1;
        const list = listTerminals([key, ...targets], translate);
        const danger = findDangerousCommand(text, { scopedBin });
        const warning = danger
            ? translate('terminal.broadcast.dangerText', { reason: translate(dangerReasonKey(danger.reason)), line: danger.line, list })
            : null;
        return confirm({
            title: translate('terminal.broadcast.pasteTitle', { count }),
            message: (
                <span className="block space-y-2 [overflow-wrap:anywhere]">
                    <span className="block">{translate('terminal.broadcast.pasteText', { list })}</span>
                    {warning && <span className="block font-medium text-rose-300">{warning}</span>}
                </span>
            ),
            confirmLabel: translate('terminal.broadcast.pasteConfirm', { count }),
            tone: danger ? 'danger' : 'default'
        });
    }, [key, scopedBin, confirm]);

    // Enter on a destructive command, or on a line that could not be checked,
    // runs it in the other terminals only once the user agrees.
    const confirmEnter = useCallback((targets: readonly string[], verdict: EnterVerdict): Promise<boolean> => {
        const count = targets.length + 1;
        const list = listTerminals([key, ...targets], translate);
        const message = verdict.danger
            ? translate('terminal.broadcast.dangerText', { reason: translate(dangerReasonKey(verdict.danger.reason)), line: verdict.danger.line, list })
            : translate('terminal.broadcast.uncheckedText', { why: translate(`terminal.broadcast.unchecked.${verdict.unchecked ?? 'screen'}`), line: verdict.line || '…', list });
        return confirm({
            title: translate('terminal.broadcast.dangerTitle', { count }),
            message: <span className="[overflow-wrap:anywhere]">{message}</span>,
            confirmLabel: translate('terminal.broadcast.dangerConfirm', { count }),
            tone: 'danger'
        });
    }, [key, confirm]);

    // Resolves once the screen has caught up with the keys: some output came
    // after the last one, then none for ENTER_QUIET_MS (ENTER_WAIT_MS at most).
    const screenSettled = useCallback(() => new Promise<void>((resolve) => {
        let quiet: ReturnType<typeof setTimeout> | null = null;
        const done = () => {
            if (quiet) clearTimeout(quiet);
            clearTimeout(limit);
            settleRef.current = null;
            resolve();
        };
        const limit = setTimeout(done, ENTER_WAIT_MS);
        const arm = () => {
            if (quiet) clearTimeout(quiet);
            quiet = setTimeout(done, ENTER_QUIET_MS);
        };
        settleRef.current = arm;
        if (trackerRef.current?.pendingLine()?.caughtUp) arm();
    }), []);

    // Whether Enter may run the line in the other terminals too: true right
    // away when the keys tell, else the answer once the screen showed the
    // line (arrow keys, Tab) or the user's answer.
    const checkEnter = useCallback((targets: readonly string[]): true | Promise<boolean> => {
        const pending = trackerRef.current?.pendingLine() ?? null;
        if (!pending?.edited) {
            const verdict = enterVerdict(pending, scopedBin);
            return verdict ? confirmEnter(targets, verdict) : true;
        }
        return screenSettled().then(() => {
            const verdict = enterVerdict(trackerRef.current?.pendingLine() ?? null, scopedBin);
            return verdict ? confirmEnter(targets, verdict) : true;
        });
    }, [scopedBin, screenSettled, confirmEnter]);

    // Our own paste was confirmed already (see paste()).
    const pastingRef = useRef(false);
    // Keys typed while an Enter waits for its check, or a paste for the
    // user's answer: they follow it, in order (or go with a refused Enter).
    const waitingRef = useRef<string[] | null>(null);
    const inputRef = useRef<(data: string) => void>(() => undefined);

    // Typed here, and into the other terminals of the group while this one
    // broadcasts (broadcast.ts decides which, and when).
    const typeInput = useCallback((data: string) => {
        const result = fanOutInput(key, data);
        const tracker = trackerRef.current;
        if (result && result.size > 1) tracker?.markBroadcast(result.size);
        tracker?.input(data);
        send(data);
        if (result?.kept) showNotice(translate(`terminal.broadcast.kept.${result.kept}`));
    }, [key, send, showNotice]);

    // Input from the keyboard (or a paste). A paste, or Enter, that would go
    // to other terminals is checked first; meanwhile what follows waits.
    const onInput = useCallback((data: string) => {
        // This terminal's focus, for its own program only: never typing,
        // never for the other terminals of a broadcast.
        if (isFocusReport(data)) {
            send(data);
            return;
        }
        if (waitingRef.current) {
            waitingRef.current.push(data);
            return;
        }
        const targets = pastingRef.current ? [] : previewTargets(key);
        if (!targets.length) {
            typeInput(data);
            return;
        }
        const resume = () => {
            const queued = waitingRef.current ?? [];
            waitingRef.current = null;
            for (const chunk of queued) inputRef.current(chunk);
        };
        if (looksLikePaste(data)) {
            waitingRef.current = [];
            void confirmPaste(targets, pastedText(data)).then((ok) => {
                if (ok) typeInput(data);
                else showNotice(translate('terminal.broadcast.notPasted'));
                resume();
            });
            return;
        }
        const enter = data.indexOf('\r');
        if (enter >= 0 && term?.buffer.active.type === 'normal') {
            if (enter > 0) typeInput(data.slice(0, enter));
            const allowed = checkEnter(targets);
            if (allowed === true) {
                typeInput(data.slice(enter));
                return;
            }
            waitingRef.current = [];
            void allowed.then((ok) => {
                if (ok) {
                    typeInput(data.slice(enter));
                    resume();
                } else {
                    // What was typed after the Enter goes with it.
                    waitingRef.current = null;
                    showNotice(translate('terminal.broadcast.notRun'));
                }
                term.focus();
            });
            return;
        }
        typeInput(data);
    }, [key, term, send, typeInput, confirmPaste, checkEnter, showNotice]);
    useEffect(() => {
        inputRef.current = onInput;
    }, [onInput]);

    const auditBroadcast = useCallback((command: string, size: number) => {
        auditBroadcastCommand(serverId, command, size, attach);
    }, [serverId, attach]);

    useEffect(() => {
        setSessionState(serverId, sessionId, { state, error: error || undefined });
    }, [serverId, sessionId, state, error, setSessionState]);

    useEffect(() => {
        setBannerHidden(false);
    }, [state, mismatch]);

    // ---- Actions -----------------------------------------------------------

    // `display`: the command with a snippet's secret values masked. It is
    // what the error markers and the chat see; such a command stays out of
    // the history (running the masked form again would not work).
    const runCommand = useCallback((command: string, source: CommandSource, focus = true, display = command) => {
        trackerRef.current?.reset();
        // A multi-line block goes the way the shell reading input now takes
        // it (see delivery.ts); what is recorded is the block as written.
        const bracketedPaste = term?.modes.bracketedPasteMode ?? false;
        const shell = sessionShell(server, term ? cursorLine(term) : '', bracketedPaste);
        const payload = terminalInput(command, deliveryFor(command, shell, bracketedPaste));
        if (!send(payload)) {
            showNotice(translate('terminal.notices.notConnected'));
            return false;
        }
        noteCommandSent(key);
        noteCommand(display);
        if (display === command) recordCommand(command, source);
        if (focus) term?.focus();
        return true;
    }, [server, key, send, noteCommand, recordCommand, showNotice, term]);

    // A command the user did not type here goes in only once a shell reads
    // input, or once the user agreed to type it anyway (see typingRisk).
    const riskNow = useCallback((command: string): TypingRisk | null => {
        if (!term) return null;
        return typingRisk(command, server, {
            alternateScreen: term.buffer.active.type === 'alternate',
            bracketedPaste: term.modes.bracketedPasteMode,
            cursorLine: cursorLine(term)
        });
    }, [term, server]);

    // The dialog names the server: its terminal may not be the one on screen.
    const askToType = useCallback((command: string, risk: TypingRisk): Promise<boolean> => confirm({
        title: risk === 'full-screen'
            ? translate('terminal.typing.fullScreenTitle', { name: server.name })
            : translate('terminal.typing.noPromptTitle', { name: server.name }),
        message: risk === 'full-screen'
            ? translate('terminal.typing.fullScreenText')
            : translate('terminal.typing.noPromptText', { count: lineCount(command) }),
        confirmLabel: translate('terminal.typing.confirm')
    }).then((ok) => {
        if (!ok) showNotice(translate('terminal.notices.notSent'));
        return ok;
    }), [server.name, confirm, showNotice]);

    // True when `command` may be typed now, otherwise the user's answer.
    const mayType = useCallback((command: string): true | Promise<boolean> => {
        const risk = riskNow(command);
        return risk ? askToType(command, risk) : true;
    }, [riskNow, askToType]);

    const runChecked = useCallback(async (command: string, source: CommandSource, focus = true): Promise<boolean> => {
        if (!canSend()) {
            showNotice(translate('terminal.notices.notConnected'));
            return false;
        }
        const allowed = mayType(command);
        if (allowed !== true && !(await allowed)) return false;
        return runCommand(command, source, focus);
    }, [canSend, mayType, runCommand, showNotice]);

    const copySelection = useCallback(async (clearAfter: boolean) => {
        const selection = term?.getSelection();
        if (!term || !selection) {
            showNotice(translate('terminal.notices.nothingSelected'));
            return;
        }
        try {
            await copyText(selection);
            showNotice(translate('terminal.notices.copied'));
            if (clearAfter) term.clearSelection();
        } catch {
            toast.error(translate('terminal.errors.copyFailed'), translate('terminal.errors.clipboardBlocked'));
        }
    }, [term, showNotice, toast]);

    const paste = useCallback(async () => {
        if (!term) return;
        if (!canSend()) {
            showNotice(translate('terminal.notices.notConnected'));
            return;
        }
        try {
            const text = await readClipboardText();
            // While broadcasting, the other terminals get it once confirmed.
            const targets = text ? previewTargets(key) : [];
            if (targets.length && !(await confirmPaste(targets, text))) {
                showNotice(translate('terminal.broadcast.notPasted'));
            } else if (text) {
                // paste() honours the shell's bracketed-paste mode.
                pastingRef.current = true;
                try {
                    term.paste(text);
                } finally {
                    pastingRef.current = false;
                }
            }
            term.focus();
        } catch {
            toast.error(translate('terminal.errors.pasteFailed'), translate('terminal.errors.clipboardBlocked'));
        }
    }, [term, canSend, showNotice, toast, key, confirmPaste]);

    const snapshot = useCallback(() => {
        if (!term) return '';
        const buffer = term.buffer.active;
        const lines: string[] = [];
        for (let row = Math.max(0, buffer.length - SNAPSHOT_LINES); row < buffer.length; row++) {
            lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
        }
        const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        return text.length > SNAPSHOT_CHARS ? text.slice(-SNAPSHOT_CHARS) : text;
    }, [term]);

    const copyOutput = useCallback(async () => {
        const text = snapshot();
        if (!text) {
            showNotice(translate('terminal.notices.noOutput'));
            return;
        }
        try {
            await copyText(text);
            showNotice(translate('terminal.notices.outputCopied'));
        } catch {
            toast.error(translate('terminal.errors.copyFailed'), translate('terminal.errors.clipboardBlocked'));
        }
    }, [snapshot, showNotice, toast]);

    const askAi = useCallback(() => {
        if (!snapshot()) {
            showNotice(translate('terminal.notices.noOutput'));
            return;
        }
        requestChat({ serverId, kind: 'prompt', prompt: translate('terminal.askAi.prompt') });
        showNotice(translate('terminal.notices.sentToAi'));
    }, [snapshot, requestChat, serverId, showNotice]);

    const clearScreen = useCallback(() => {
        if (!term) return;
        term.clear();
        xterm?.search.clearDecorations();
        markersRef.current?.clear();
        // The shell redraws its prompt (Ctrl+L); full-screen programs are left alone.
        if (term.buffer.active.type === 'normal') send('\x0c');
        term.focus();
        showNotice(translate('terminal.notices.cleared'));
    }, [term, xterm, send, showNotice]);

    const runSearch = useCallback((direction: 'next' | 'previous', value: string, incremental = false) => {
        if (!xterm) return;
        const text = value.trim();
        if (!text) {
            xterm.search.clearDecorations();
            setSearchStats({ index: -1, count: 0 });
            return;
        }
        const options = { ...SEARCH_OPTIONS, decorations: overlayColorsRef.current.search, incremental };
        const found = direction === 'previous' ? xterm.search.findPrevious(text, options) : xterm.search.findNext(text, options);
        if (!found) setSearchStats({ index: -1, count: 0 });
    }, [xterm, overlayColorsRef]);

    useEffect(() => {
        if (!xterm) return undefined;
        const subscription = xterm.search.onDidChangeResults(({ resultIndex, resultCount }) => {
            setSearchStats({ index: resultIndex, count: resultCount });
        });
        return () => subscription.dispose();
    }, [xterm]);

    const openPanel = useCallback((kind: TerminalPanelKind) => {
        setMenu(null);
        setPanel(kind);
        if (kind === 'search' && searchValue.trim()) requestAnimationFrame(() => runSearch('next', searchValue));
    }, [searchValue, runSearch]);

    const closePanel = useCallback(() => {
        setPanel((current) => {
            if (current === 'search') xterm?.search.clearDecorations();
            return null;
        });
        term?.focus();
    }, [term, xterm]);

    const togglePanel = useCallback((kind: TerminalPanelKind) => {
        if (panel === kind) closePanel();
        else openPanel(kind);
    }, [panel, closePanel, openPanel]);

    const openMenuAtCursor = useCallback(() => {
        const element = containerRef.current;
        if (!term || !element) return;
        const rect = element.getBoundingClientRect();
        const buffer = term.buffer.active;
        setMenu({
            x: rect.left + (buffer.cursorX * rect.width) / Math.max(term.cols, 1),
            y: rect.top + ((buffer.cursorY + 1) * rect.height) / Math.max(term.rows, 1)
        });
    }, [term]);

    const closeMenu = useCallback(() => {
        setMenu(null);
        term?.focus();
    }, [term]);

    const onMenuAction = (action: ContextMenuAction) => {
        setMenu(null);
        switch (action) {
            case 'copy': void copySelection(false); break;
            case 'paste': void paste(); break;
            case 'select-all': term?.selectAll(); break;
            case 'search': openPanel('search'); return;
            case 'ask-ai': askAi(); break;
            case 'clear': clearScreen(); return;
            // After the menu has given the focus back to where it was.
            case 'focus-toolbar': requestAnimationFrame(() => toolbarRef.current?.focus()); return;
        }
        term?.focus();
    };

    const fixLine = useCallback((line: string) => {
        reportIssueLine(serverId, line);
        requestChat({ serverId, kind: 'fix-issue' });
    }, [serverId, requestChat]);

    const pickHint = async (hint: Hint) => {
        setPanel(null);
        if (!hint.editable) {
            await runChecked(hint.cmd, 'hint');
            return;
        }
        if (!canSend()) {
            showNotice(t('terminal.notices.notConnected'));
            return;
        }
        const allowed = mayType(hint.cmd);
        if (allowed !== true && !(await allowed)) return;
        trackerRef.current?.reset();
        trackerRef.current?.programmaticInput();
        if (send(hint.cmd)) {
            term?.focus();
            showNotice(t('terminal.notices.editHint'));
        } else {
            showNotice(t('terminal.notices.notConnected'));
        }
    };

    const rerun = async (entry: HistoryEntry) => {
        setPanel(null);
        if (await runChecked(entry.command, entry.source)) showNotice(t('terminal.notices.rerun'));
    };

    const runFavorite = (entry: FavoriteEntry) => {
        setPanel(null);
        void runChecked(entry.command, 'hint');
    };

    const trustNewKey = async () => {
        if (!mismatch) return;
        const ok = await confirm({
            title: t('terminal.hostKey.confirmTitle'),
            // Fingerprints are one long word: let them wrap anywhere.
            message: (
                <span className="[overflow-wrap:anywhere]">
                    {t('terminal.hostKey.confirmText', { host: mismatch.host, port: mismatch.port, fingerprint: mismatch.actual })}
                </span>
            ),
            confirmLabel: t('terminal.hostKey.confirm'),
            tone: 'danger'
        });
        if (!ok) return;
        setTrusting(true);
        // The backend swaps the pinned key for exactly the one confirmed here.
        const result = await trustHostKey(mismatch);
        setTrusting(false);
        if (result.ok) {
            reconnect();
        } else if (result.code === 'HOST_KEY_CHANGED') {
            // Show the keys as they are now.
            toast.error(t('terminal.errors.trustFailed'), t('terminal.errors.keyChangedAgain'));
            reconnect();
        } else {
            toast.error(t('terminal.errors.trustFailed'), result.error);
        }
    };

    // ---- Wiring ------------------------------------------------------------

    const keyContext = useLatest({ panel, server, mac });
    const actions = useLatest({ copySelection, paste, openPanel, closePanel, openMenuAtCursor, recordCommand, noteCommand, fixLine, onInput, auditBroadcast });

    useEffect(() => {
        if (!term) return undefined;
        const screen: TerminalScreen = {
            cursor: () => {
                const buffer = term.buffer.active;
                return { row: buffer.baseY + buffer.cursorY, col: buffer.cursorX };
            },
            lineText: (row) => term.buffer.active.getLine(row)?.translateToString(true) ?? '',
            isWrapped: (row) => term.buffer.active.getLine(row)?.isWrapped ?? false,
            isAlternateScreen: () => term.buffer.active.type === 'alternate',
            trackCursorRow: () => term.registerMarker(0) ?? null
        };
        const tracker = new CommandTracker(
            screen,
            (command, details) => {
                actions.current.recordCommand(command, 'typed');
                if (details.broadcast) actions.current.auditBroadcast(command, details.broadcast);
            },
            (command) => actions.current.noteCommand(command)
        );
        const markers = new ErrorMarkers(term, {
            label: () => translate('terminal.issue.fix'),
            colors: () => overlayColorsRef.current.error,
            onFix: (line) => actions.current.fixLine(line)
        });
        trackerRef.current = tracker;
        markersRef.current = markers;

        const input = term.onData((data) => actions.current.onInput(data));
        term.attachCustomKeyEventHandler((event) => {
            const { panel: openPanelKind, server: currentServer, mac: isMac } = keyContext.current;
            const isAppShortcut = event.type === 'keydown'
                && Boolean(actionRegistry.forShortcut(event, currentServer))
                && !belongsToProgram(event, isMac);
            const action = terminalKeyAction(event, {
                mac: isMac,
                hasSelection: term.hasSelection(),
                searchOpen: openPanelKind === 'search',
                isAppShortcut
            });
            if (action === 'pass') return true;
            // Not handled by xterm, so the window's shortcut handler sees it
            // (or, for a pane key, the terminal panel: TerminalPanel).
            if (action === 'app-shortcut' || action === 'pane-shortcut') return false;
            event.preventDefault();
            const run = actions.current;
            if (action === 'copy') void run.copySelection(true);
            else if (action === 'paste') void run.paste();
            else if (action === 'search') run.openPanel('search');
            else if (action === 'close-search') run.closePanel();
            else if (action === 'context-menu') run.openMenuAtCursor();
            else if (action === 'focus-toolbar') toolbarRef.current?.focus();
            return false;
        });

        return () => {
            input.dispose();
            tracker.dispose();
            markers.dispose();
            trackerRef.current = null;
            markersRef.current = null;
        };
    }, [term, actions, keyContext, overlayColorsRef]);

    // A light scheme after a dark one (or the other way round): the error
    // highlights already drawn take the new colours.
    const schemeKind = appearance.scheme.kind;
    useEffect(() => {
        markersRef.current?.recolor();
    }, [schemeKind]);

    // Whether a full-screen program (vi, less, top) holds the terminal.
    const [fullScreen, setFullScreen] = useState(false);
    useEffect(() => {
        if (!term) return undefined;
        setFullScreen(term.buffer.active.type === 'alternate');
        const subscription = term.buffer.onBufferChange((buffer) => {
            setFullScreen(buffer.type === 'alternate');
            // A "type anyway" of broadcast input was for the screen before.
            noteBufferChange(key);
        });
        return () => subscription.dispose();
    }, [term, key]);

    // Whether the shell of the live session had its chance to show its prompt
    // (see shellReady.ts); false while connecting and after the session ended.
    const [shellReady, setShellReady] = useState(false);
    useEffect(() => {
        if (!term) return undefined;
        const readiness = new ShellReadiness(
            () => isReadingInput({ cursorLine: cursorLine(term), bracketedPaste: term.modes.bracketedPasteMode }),
            () => setShellReady(true)
        );
        readinessRef.current = readiness;
        return () => {
            readiness.stop();
            readinessRef.current = null;
        };
    }, [term]);
    useEffect(() => {
        setShellReady(false);
        if (state === 'connected') readinessRef.current?.start();
        else readinessRef.current?.stop();
    }, [state, term]);

    // Auto-Run steps are typed right away into a shell prompt or not at all
    // (see commandDelivery.ts): never held for later, never asked about.
    const refuseAutoRunSteps = useCallback((entries: QueuedCommand[], reason: keyof typeof AUTO_RUN_REFUSED) => {
        for (const entry of entries) reportUndelivered(entry, serverId, reason);
        if (entries.length) showNotice(translate(AUTO_RUN_REFUSED[reason]));
    }, [serverId, showNotice]);

    // Commands queued for this server (AI chat, snippets...) are typed into
    // the focused tab once it is connected and its shell is ready, and
    // audited as they are sent. While a full-screen program runs they wait
    // (it would get them as keystrokes); the banner offers to type them
    // anyway or drop them. A shell inside a container is not the server's:
    // they wait there too (Auto-Run steps are refused at once), and its
    // banner offers to run them in a tab of the server instead.
    const takeCommands = useAppStore((store) => store.takeCommands);
    const drainingRef = useRef(false);
    const [drained, setDrained] = useState(0);
    useEffect(() => {
        if (attach && focused && queuedCount > 0) refuseAutoRunSteps(takeQueuedWhere(serverId, isAutoRunStep), 'container-shell');
    }, [attach, focused, queuedCount, serverId, refuseAutoRunSteps]);
    useEffect(() => {
        if (attach || !focused || state !== 'connected' || !shellReady || queuedCount === 0 || drainingRef.current || !canSend()) return;
        if (fullScreen) {
            refuseAutoRunSteps(takeQueuedWhere(serverId, isAutoRunStep), 'full-screen');
            return;
        }
        drainingRef.current = true;
        // Synchronous unless the user has to be asked.
        void (async () => {
            try {
                for (const entry of takeCommands(serverId)) {
                    const risk = riskNow(entry.command);
                    if (risk && isAutoRunStep(entry)) {
                        refuseAutoRunSteps([entry], risk);
                        continue;
                    }
                    if (risk && !(await askToType(entry.display ?? entry.command, risk))) {
                        reportUndelivered(entry, serverId, 'declined');
                        continue;
                    }
                    if (runCommand(entry.command, entry.source, false, entry.display)) auditSentCommand(serverId, entry.display ?? entry.command, entry.source);
                    else reportUndelivered(entry, serverId, 'not-connected');
                }
            } finally {
                drainingRef.current = false;
                // Commands queued meanwhile are taken on the next pass.
                setDrained((count) => count + 1);
            }
        })();
    }, [attach, focused, state, shellReady, queuedCount, fullScreen, canSend, takeCommands, serverId, riskNow, askToType, refuseAutoRunSteps, runCommand, drained]);

    // A step queued just before the session ended would otherwise be typed
    // into the next session, long after its chain gave up on it.
    useEffect(() => {
        if (focused && queuedCount > 0 && (state === 'disconnected' || state === 'error')) {
            refuseAutoRunSteps(takeQueuedWhere(serverId, isAutoRunStep), 'not-connected');
        }
    }, [focused, queuedCount, state, serverId, refuseAutoRunSteps]);

    // The user chose to type the waiting commands here (into the full-screen
    // program, or into the container's shell: audited as such).
    const typeHeldCommands = () => {
        for (const entry of takeCommands(serverId)) {
            if (runCommand(entry.command, entry.source, false, entry.display)) auditSentCommand(serverId, entry.display ?? entry.command, entry.source, attach);
            else reportUndelivered(entry, serverId, 'not-connected');
        }
        term?.focus();
    };
    // The waiting commands go to a tab of the server's own shell (focused, it
    // types them as usual), or to a new one.
    const runHeldOnServer = () => {
        const store = useAppStore.getState();
        const sessions = store.terminalSessions[serverId]?.sessions ?? [];
        const hostTabs = sessions.filter((session) => !session.attach);
        const target = hostTabs.find((session) => session.state === 'connected') ?? hostTabs[0];
        if (target) store.focusTerminalSession(serverId, target.id);
        else store.openTerminalSession(serverId);
    };
    const discardHeldCommands = () => {
        for (const entry of takeCommands(serverId)) reportUndelivered(entry, serverId, 'discarded');
        showNotice(t('terminal.notices.waitingDiscarded'));
        term?.focus();
    };

    // Several tabs are on screen side by side: the focused one takes the keys.
    useEffect(() => {
        if (visible && focused) term?.focus();
    }, [visible, focused, term]);

    // The focused tab is the one the chat reads: tell it where to continue.
    useEffect(() => {
        if (focused && term) callbacks.onFocused(sessionId, screenUpToCursor(term));
    }, [focused, term, callbacks, sessionId]);

    // ---- Render ------------------------------------------------------------

    const onContextMenu = (event: ReactMouseEvent) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
    };
    const onMouseDown = (event: ReactMouseEvent) => {
        // Middle-click paste (classic terminal convention).
        if (event.button === 1) {
            event.preventDefault();
            void paste();
        }
    };

    const showHostKey = Boolean(mismatch) && !bannerHidden;
    const showBanner = !showHostKey && !bannerHidden && (state === 'disconnected' || state === 'error');
    const showHeld = !attach && focused && state === 'connected' && fullScreen && queuedCount > 0;
    const showContainerHeld = Boolean(attach) && focused && queuedCount > 0;
    const hasHints = hintGroupsFor(server).length > 0;

    const toolbar = (
        <SessionToolbar
            ref={toolbarRef}
            panel={panel}
            hasHints={hasHints}
            shortcuts={shortcuts}
            onPaste={() => void paste()}
            onCopySelection={() => void copySelection(false)}
            onCopyOutput={() => void copyOutput()}
            onAskAi={askAi}
            onClear={clearScreen}
            onTogglePanel={togglePanel}
            onLeave={() => term?.focus()}
        />
    );

    return (
        <div className="relative flex h-full w-full flex-col" style={{ background: appearance.scheme.theme.background }}>
            {focused && toolbarSlot && createPortal(toolbar, toolbarSlot)}

            {showHostKey && mismatch && (
                <HostKeyBanner mismatch={mismatch} busy={trusting} onTrust={() => void trustNewKey()} onDismiss={() => setBannerHidden(true)} />
            )}
            {showBanner && (
                <SessionBanner
                    state={state === 'error' ? 'error' : offline ? 'offline' : 'disconnected'}
                    error={error}
                    detail={errorDetail}
                    onReconnect={reconnect}
                    onDismiss={() => setBannerHidden(true)}
                />
            )}
            {showHeld && <HeldCommandsBanner count={queuedCount} onTypeNow={typeHeldCommands} onDiscard={discardHeldCommands} />}
            {showContainerHeld && attach && (
                <ContainerHeldBanner
                    count={queuedCount}
                    server={server.name}
                    container={attach.container}
                    canType={state === 'connected'}
                    onRunOnServer={runHeldOnServer}
                    onTypeHere={typeHeldCommands}
                    onDiscard={discardHeldCommands}
                />
            )}

            <div className="relative min-h-0 flex-1">
                {/* The padding sits outside the terminal's own box: the fit measures that box, and a pane of any height then shows its last row whole. */}
                <div className="h-full w-full overflow-hidden pl-2 pt-1">
                    {/* The terminal itself is a focusable widget; these mouse handlers only add a context menu and middle-click paste. */}
                    {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
                    <div
                        ref={containerRef}
                        onContextMenu={onContextMenu}
                        onMouseDown={onMouseDown}
                        className="h-full w-full overflow-hidden"
                    />
                </div>

                {panel === 'search' && (
                    <SearchPanel
                        value={searchValue}
                        stats={searchStats}
                        shortcut={shortcuts.search}
                        onChange={(value) => {
                            setSearchValue(value);
                            runSearch('next', value, true);
                        }}
                        onNext={() => runSearch('next', searchValue)}
                        onPrevious={() => runSearch('previous', searchValue)}
                        onClose={closePanel}
                    />
                )}
                {panel === 'history' && (
                    <HistoryPanel
                        serverId={serverId}
                        serverName={server.name}
                        onRun={(entry) => void rerun(entry)}
                        onRunFavorite={runFavorite}
                        onNotice={showNotice}
                        onClose={closePanel}
                    />
                )}
                {panel === 'hints' && <HintsPanel server={server} onPick={(hint) => void pickHint(hint)} onClose={closePanel} />}
            </div>

            <div aria-live="polite" className="pointer-events-none absolute left-1/2 top-3 z-50 -translate-x-1/2">
                {notice && (
                    <div className="rounded-lg border border-white/10 bg-ink-700/95 px-3 py-1.5 text-[11px] text-zinc-200 shadow-soft animate-fade-in">
                        {notice}
                    </div>
                )}
            </div>

            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    hasSelection={Boolean(term?.hasSelection())}
                    shortcuts={shortcuts}
                    onAction={onMenuAction}
                    onClose={closeMenu}
                />
            )}
        </div>
    );
}

export default memo(TerminalSession);
