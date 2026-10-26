import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Bot, Star } from 'lucide-react';
import type { ChatAttachment, ChatCommandOutput, ChatEvidence, ChatRequestBody } from '@shared/chat';
import { recollectAttachment } from '@shared/chatEvidence';
import { findDangerousCommand } from '@shared/commandSafety';
import {
    findModel,
    MAX_COMMAND_OUTPUT_CHARS,
    MAX_CONTEXT_ISSUES,
    MAX_TERMINAL_CONTEXT_CHARS,
    MAX_TERMINAL_CONTEXT_LINES,
    MODELS
} from '@shared/models';
import { expandEncodedBlocks, showsRunnerEcho } from '@shared/powershell';
import { cliPresetInfo } from '@shared/shells';
import { defaultAskAiPrompt } from '@/components/AskAiButton';
import { Select, useConfirm, useToast, type ConnState } from '@/components/ui';
import { useLanguage, useT, type TranslateFn } from '@/i18n';
import { formatBytes } from '@/lib/format';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { focusedTerminalAttach, useAppStore } from '@/store/appStore';
import { readTerminalOutputSince, recentTerminalOutput, terminalOutputMark, terminalOutputSession } from '@/store/terminalOutput';
import type { WorkspaceServer } from '@/workspace/types';
import { onCommandUndelivered } from '@/features/terminal/commandDelivery';
import { AutoRunConfirmDialog, AutoRunStatus, AutoRunToggle, DANGER_KEYS } from './components/AutoRun';
import { ChatHeader } from './components/ChatHeader';
import { Composer } from './components/Composer';
import { AttachmentCard } from './components/Evidence';
import { IssueCard } from './components/IssueCard';
import { MessageBody } from './components/MessageBody';
import { MessageItem } from './components/MessageItem';
import { ProviderNotice, useMiniMaxDisclosure } from './components/ProviderNotice';
import { useAttachment, type PendingAttachment } from './hooks/useAttachment';
import { useAutoRun } from './hooks/useAutoRun';
import { useChatHistory } from './hooks/useChatHistory';
import { chooseChatModel, useChatModel } from './hooks/useChatModel';
import { useChatStream } from './hooks/useChatStream';
import { useElementHeight } from './hooks/useElementHeight';
import { useFixIt, type FixItState } from './hooks/useFixIt';
import { useProgressiveMessages } from './hooks/useProgressiveMessages';
import { useStableCallback } from './hooks/useStableCallback';
import { useStickToBottom } from './hooks/useStickToBottom';
import type { AutoRunNotice, AutoRunNotTypedReason } from './lib/autoRun';
import { attachmentLabel, evidenceBytes, isEvidenceStale } from './lib/evidence';
import { runnableCommands, type RunTarget } from './lib/fences';
import { clipMiddle, toHistoryPayload } from './lib/history';
import { errorMessage, isConversation, messageId, notice, type ChatMessage, type TerminalIssue } from './types';

export type ChatPanelProps = {
    activeServer: WorkspaceServer | null;
    connectionState?: ConnState;
    // W7-S6: the terminal's own state, which Auto-Run types into (default:
    // connectionState, which also counts a Remote Desktop session).
    shellState?: ConnState;
    // Terminal output comes from the per-server feed of the focused terminal
    // tab (src/store/terminalOutput.ts); issues from src/lib/terminalIssues.ts.
    terminalIssues?: TerminalIssue[];
    onDismissTerminalIssue?: (issueId: string) => void;
    onClearTerminalIssues?: () => void;
};

const NO_ISSUES: TerminalIssue[] = [];
const FIX_IT_IDLE: FixItState = { status: 'idle' };
const MODEL_OPTIONS = MODELS.map((model) => ({ value: model.id, label: model.label }));

// The composer grows up to this share of the chat panel, and never past
// COMPOSER_MAX_PX, so the conversation stays readable while typing.
const COMPOSER_MAX_RATIO = 0.35;
const COMPOSER_MAX_PX = 220;
const COMPOSER_MIN_PX = 78;

// `hasIssue`: the card of the terminal's last issue is shown below.
function greeting(t: TranslateFn, server: WorkspaceServer | null, state: ConnState | undefined, hasIssue: boolean): string {
    if (!server) return t('chat.greeting.noServer');
    const name = server.name;
    if (server.type === 's3') return t('chat.greeting.s3', { name });
    if (state === 'connected') return t('chat.greeting.connected', { name });
    if (state === 'error') return t(hasIssue ? 'chat.greeting.error' : 'chat.greeting.errorNoIssue', { name });
    if (state === 'disconnected') return t('chat.greeting.disconnected', { name });
    // Its shell waits for its tab (a Windows server opens on its desktop).
    if (state === 'idle') return t('chat.greeting.idle', { name });
    return t('chat.greeting.connecting', { name });
}

function formatIssue(issue: TerminalIssue): string {
    return `${issue.type.toUpperCase()}: ${issue.message}${issue.details ? `\n  ${issue.details.replace(/\n/g, '\n  ')}` : ''}`;
}

const NOT_TYPED_KEYS: Record<AutoRunNotTypedReason, string> = {
    'full-screen': 'chat.notices.autoRunFullScreen',
    'no-prompt': 'chat.notices.autoRunNoPrompt',
    'not-connected': 'chat.notices.autoRunNotTyped',
    'container-shell': 'chat.notices.autoRunContainer'
};

function autoRunNoticeMessage(event: AutoRunNotice): ChatMessage {
    switch (event.type) {
        case 'paused-limit': return notice('chat.notices.autoRunPaused', { steps: event.steps }, 'warning');
        case 'paused-running': return notice('chat.notices.autoRunStillRunning', { seconds: event.seconds }, 'warning');
        case 'not-connected': return notice('chat.notices.autoRunNotConnected', undefined, 'warning');
        case 'no-output': return notice('chat.notices.autoRunNoOutput');
        case 'session-changed': return notice('chat.notices.autoRunSessionChanged', undefined, 'warning');
        case 'skipped': return notice('chat.notices.autoRunSkipped');
        case 'stopped': return notice('chat.notices.autoRunStopped');
        case 'not-typed': return notice(NOT_TYPED_KEYS[event.reason], undefined, 'warning');
    }
}

const modelLabel = (id: string) => findModel(id)?.label ?? id;

// An "Ask AI" request still waiting after this long (its server never
// opened: the user declined to close another one) is dropped, not acted on
// whenever that server is opened later.
const CONTEXT_REQUEST_TTL_MS = 60_000;

// What a streamed request belongs to: the question of a diagnosis, whose
// evidence is collected again if the backend no longer accepts it.
type StreamOptions = { question?: ChatMessage };

// The AI chat of one connection. App mounts one per server (keyed by id), so
// its conversation, Auto-Run consent and requests never leak to another one.
export default function ChatPanel({
    activeServer,
    connectionState,
    shellState = connectionState,
    terminalIssues = NO_ISSUES,
    onDismissTerminalIssue,
    onClearTerminalIssues
}: ChatPanelProps) {
    const t = useT();
    const language = useLanguage();
    const toast = useToast();
    const confirm = useConfirm();
    const queueCommand = useAppStore((state) => state.queueCommand);
    const chatRequest = useAppStore((state) => state.chatRequest);
    const consumeChatRequest = useAppStore((state) => state.consumeChatRequest);
    const chatOpen = useAppStore((state) => state.chatOpen);
    const activeServerId = useAppStore((state) => state.activeServerId);

    const server = activeServer;
    const serverId = server?.id ?? null;
    const serverName = server?.name ?? '';
    // Open servers keep their chats mounted; only the active server's is shown.
    const onScreen = chatOpen && (serverId == null || activeServerId == null || activeServerId === serverId);
    const hasShell = server != null && server.type !== 's3';
    const scopedBin = server?.type === 'local' ? cliPresetInfo(server.cli_preset)?.bin ?? null : null;
    const target = useMemo<RunTarget>(() => ({ scopedBin, ftp: server?.type === 'ftp' }), [scopedBin, server?.type]);

    const [input, setInput] = useState('');
    const model = useChatModel();
    const [autoRunDialogOpen, setAutoRunDialogOpen] = useState(false);
    const [announcement, setAnnouncement] = useState('');
    const panelRef = useRef<HTMLDivElement>(null);
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const panelHeight = useElementHeight(panelRef);
    const composerMaxHeight = Math.max(COMPOSER_MIN_PX, Math.min(COMPOSER_MAX_PX, Math.round((panelHeight || window.innerHeight) * COMPOSER_MAX_RATIO)));

    const history = useChatHistory(serverId, () => toast.warning(t('chat.messages.saveFailed')));
    const { messages, setMessages } = history;
    const messagesRef = useRef(messages);
    useEffect(() => {
        messagesRef.current = messages;
    });
    const stream = useChatStream();
    const disclosure = useMiniMaxDisclosure(findModel(model)?.provider === 'minimax');

    const appendMessages = useStableCallback((...items: ChatMessage[]) => {
        if (items.length) setMessages((current) => [...current, ...items]);
    });

    // Notices are also read out: the conversation log itself is not a live
    // region (it would read every streamed token).
    const appendNotice = useStableCallback((item: ChatMessage) => {
        appendMessages(item);
        if (item.noticeKey) setAnnouncement(t(item.noticeKey, item.noticeParams));
    });

    // The attachment of the message being written ("Ask AI" buttons): its
    // evidence is collected right away and announced when it is in.
    const attachment = useAttachment(serverId, (settled: PendingAttachment) => {
        const name = attachmentLabel(t, settled.attachment);
        if (settled.status === 'ready') {
            setAnnouncement(t('chat.evidence.announceReady', { name, size: formatBytes(evidenceBytes(settled.evidence), language, { fixed: true }) }));
        } else if (settled.status === 'error') {
            setAnnouncement(t('chat.evidence.announceFailed', { name }));
        }
    });
    const pendingAttachment = attachment.pending;
    const attachFor = attachment.attach;

    // Context sent with every request: the server (its environment is read
    // from the DB by the backend), recent terminal output and issues.
    const requestContext = useStableCallback((): ChatRequestBody => {
        const shell = serverId != null ? focusedTerminalAttach(useAppStore.getState().terminalSessions[serverId]) : undefined;
        const raw = serverId != null ? expandEncodedBlocks(recentTerminalOutput(serverId, MAX_TERMINAL_CONTEXT_CHARS * 2)) : '';
        const terminalOutput = raw.split('\n').slice(-MAX_TERMINAL_CONTEXT_LINES).join('\n').slice(-MAX_TERMINAL_CONTEXT_CHARS);
        return {
            model,
            serverId: serverId ?? undefined,
            osDetail: server?.osDetail ?? server?.os_detail ?? undefined,
            terminalOutput: terminalOutput.trim() ? terminalOutput : undefined,
            issues: terminalIssues.length ? terminalIssues.slice(-MAX_CONTEXT_ISSUES).map(formatIssue) : undefined,
            // W8-T2: or a shell inside a Kubernetes pod.
            terminalShell: shell
                ? shell.kind === 'pod'
                    ? { kind: 'pod', context: shell.context, namespace: shell.namespace, pod: shell.pod, container: shell.container }
                    : { kind: 'container', engine: shell.engine, container: shell.container }
                : undefined,
            autoRun: autoRun.controller.getState().enabled || undefined
        };
    });

    const autoRun = useAutoRun({
        runnableCommands: (answer, complete) => runnableCommands(answer, target, { complete }),
        scopedBin: () => scopedBin,
        isConnected: () => hasShell && shellState === 'connected',
        run: (command) => {
            if (serverId != null) queueCommand(serverId, command, 'ai-autorun');
        },
        outputMark: () => (serverId != null ? terminalOutputMark(serverId) : 0),
        readOutputSince: (mark) => (serverId != null ? readTerminalOutputSince(serverId, mark) : { text: '', truncated: false, total: 0 }),
        outputSession: () => (serverId != null ? terminalOutputSession(serverId) : null),
        analyze: (output) => analyze(output),
        notify: (event) => appendNotice(autoRunNoticeMessage(event))
    });
    const autoRunState = autoRun.state;
    const busy = stream.isStreaming || autoRunState.phase !== 'idle';

    // What the request being streamed is for: closing the chat cancels an
    // Auto-Run analysis, not an answer the user asked for.
    const streamPurposeRef = useRef<ChatRequestBody['purpose']>(undefined);

    const streamAnswer = useStableCallback((request: ChatRequestBody, options: StreamOptions = {}) => {
        const epoch = history.epoch();
        streamPurposeRef.current = request.purpose;
        setAnnouncement('');
        void stream.run(request, (outcome) => {
            // Cleared meanwhile: the answer belongs to a forgotten conversation.
            if (epoch !== history.epoch()) return;
            const diagnosis = request.purpose === 'diagnose';
            if (outcome.kind === 'done') {
                const switched = outcome.fallbackFrom && outcome.usedModel && outcome.usedModel !== outcome.fallbackFrom
                    ? notice('chat.notices.modelSwitched', { model: modelLabel(outcome.usedModel), previous: modelLabel(outcome.fallbackFrom) }, 'warning')
                    : null;
                // Keep going with the model that works this session.
                if (switched && outcome.usedModel && findModel(outcome.usedModel)) chooseChatModel(outcome.usedModel);
                const extra: ChatMessage[] = switched ? [switched] : [];
                if (outcome.text.trim()) {
                    extra.push({ id: messageId('ai'), role: 'assistant', kind: 'chat', content: outcome.text, model: outcome.usedModel ?? undefined, stopReason: outcome.stopReason });
                }
                // The fix of a diagnosis waits for the user's click, also with Auto-Run on.
                if (diagnosis && autoRun.controller.getState().enabled && runnableCommands(outcome.text, target, { complete: true }).length) {
                    extra.push(notice('chat.notices.diagnoseNotAutoRun'));
                }
                appendMessages(...extra);
                setAnnouncement(switched?.noticeKey
                    ? `${t(switched.noticeKey, switched.noticeParams)} ${t('chat.messages.answerReady')}`
                    : t('chat.messages.answerReady'));
                if (!diagnosis) autoRun.controller.onAnswer(outcome.text, outcome.stopReason !== 'max_tokens');
                return;
            }
            autoRun.controller.analysisFailed();
            if (outcome.kind === 'error' && outcome.failure.key === 'chat.errors.evidenceExpired' && options.question) {
                recollect(options.question);
                return;
            }
            const items: ChatMessage[] = [];
            if (outcome.partial.trim()) items.push({ id: messageId('ai'), role: 'assistant', kind: 'chat', content: outcome.partial, stopped: true });
            // Shown with role="alert", so it is read out on its own.
            if (outcome.kind === 'error') items.push(errorMessage(outcome.failure.key, outcome.failure.params));
            appendMessages(...items);
        });
    });

    const analyze = useStableCallback((output: ChatCommandOutput) => {
        // PowerShell blocks are echoed as the line that ran them: the AI
        // reads the block itself. The redraws of a long one can push the
        // start of the capture out of what the feed retains; when the capture
        // still shows where its echo ends, everything the block printed is there.
        const text = expandEncodedBlocks(output.output);
        const truncated = output.truncated && !showsRunnerEcho(output.output);
        const clipped = clipMiddle(text, MAX_COMMAND_OUTPUT_CHARS);
        const prior = messagesRef.current;
        appendMessages({ id: messageId('out'), role: 'user', kind: 'command-output', command: output.command, content: clipped, stillRunning: output.stillRunning });
        streamAnswer({
            ...requestContext(),
            purpose: 'autorun-step',
            commandOutput: {
                command: output.command,
                output: clipped,
                truncated: truncated || clipped !== text,
                ...(output.stillRunning ? { stillRunning: true } : {})
            },
            history: toHistoryPayload(prior)
        });
    });

    const rendered = useProgressiveMessages(messages);
    // Showing the chat again counts as new content: a notice added while it
    // was hidden (Auto-Run turned off) must be in view when it is shown again.
    const scroll = useStickToBottom(
        listRef,
        `${onScreen}:${messages.length}:${rendered.hidden}:${stream.live ? 'live' : 'idle'}:${autoRunState.phase}`,
        stream.live?.text.length ?? -1
    );

    const focusComposer = () => window.requestAnimationFrame(() => {
        const el = composerRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
    });

    // An "Ask AI" button pointed the chat at something: its question goes in
    // the message box and its evidence is attached (collected now, shown as it
    // will be sent). Nothing goes to the AI until the user sends it. The
    // question replaces an empty box or the one an earlier "Ask AI" put
    // there, never what the user wrote.
    const askedPromptRef = useRef<string | null>(null);
    const attachContext = useStableCallback((target: ChatAttachment, prompt: string | undefined) => {
        const question = prompt ?? defaultAskAiPrompt(t, target);
        const previous = askedPromptRef.current;
        setInput((current) => (!current.trim() || current === previous ? question : current));
        askedPromptRef.current = question;
        attachFor(target);
        setAnnouncement(t('chat.evidence.collecting', { name: serverName }));
        focusComposer();
    });

    // The evidence the backend no longer accepts (too old, or collected
    // before it restarted): the question goes back to the message box and
    // the evidence is collected again, for the user to check and send.
    const recollect = useStableCallback((question: ChatMessage) => {
        if (!question.evidence) return;
        setMessages((current) => current.filter((message) => message.id !== question.id));
        setInput((current) => (current.trim() ? current : question.content));
        attachFor(recollectAttachment(question.evidence));
        appendNotice(notice('chat.notices.evidenceRecollected', undefined, 'warning'));
        focusComposer();
    });

    const diagnose = useStableCallback((question: ChatMessage, evidence: ChatEvidence, prior: ChatMessage[]) => {
        if (isEvidenceStale(evidence)) {
            recollect(question);
            return;
        }
        streamAnswer(
            { ...requestContext(), purpose: 'diagnose', message: question.content, attachment: evidence.attachment, evidence, language, history: toHistoryPayload(prior) },
            { question }
        );
    });

    const send = useStableCallback(() => {
        const text = input.trim();
        if (busy) return;
        if (pendingAttachment) {
            if (pendingAttachment.status !== 'ready') return;
            const { evidence } = pendingAttachment;
            const prior = messagesRef.current;
            const question: ChatMessage = { id: messageId('user'), role: 'user', kind: 'chat', content: text || defaultAskAiPrompt(t, evidence.attachment), evidence };
            appendMessages(question);
            setInput('');
            attachment.remove();
            scroll.scrollToBottom();
            diagnose(question, evidence, prior);
            return;
        }
        if (!text) return;
        autoRun.controller.resetBudget();
        const prior = messagesRef.current;
        appendMessages({ id: messageId('user'), role: 'user', kind: 'chat', content: text });
        setInput('');
        scroll.scrollToBottom();
        streamAnswer({ ...requestContext(), purpose: 'chat', message: text, history: toHistoryPayload(prior) });
    });

    // Asks again for the answer to the last user turn (a message, a
    // diagnosis or the output of an Auto-Run command), dropping what came
    // after it.
    const regenerate = useStableCallback(() => {
        if (busy) return;
        const current = messagesRef.current;
        let index = current.length - 1;
        while (index >= 0 && !(current[index].role === 'user' && isConversation(current[index]))) index--;
        if (index === -1) return;
        const turn = current[index];
        const prior = current.slice(0, index);
        setMessages(current.slice(0, index + 1));
        autoRun.controller.resetBudget();
        if (turn.evidence) {
            diagnose(turn, turn.evidence, prior);
        } else if (turn.kind === 'command-output') {
            streamAnswer({ ...requestContext(), purpose: 'autorun-step', commandOutput: { command: turn.command ?? '', output: turn.content }, history: toHistoryPayload(prior) });
        } else {
            streamAnswer({ ...requestContext(), purpose: 'chat', message: turn.content, history: toHistoryPayload(prior) });
        }
    });

    const runCommand = useStableCallback(async (command: string) => {
        if (serverId == null || !hasShell) {
            toast.warning(t('chat.run.noServer'), t('app.commandQueue.noServerHint'));
            return;
        }
        const danger = findDangerousCommand(command, { scopedBin });
        if (danger) {
            const ok = await confirm({
                title: t('chat.run.dangerTitle'),
                message: (
                    <>
                        <p className="mb-2">{t('chat.run.dangerMessage', { reason: t(DANGER_KEYS[danger.reason]), name: serverName })}</p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/50 p-2 font-mono text-[11px] text-zinc-100">{command}</pre>
                    </>
                ),
                confirmLabel: t('chat.run.runAnyway'),
                tone: 'danger'
            });
            if (!ok) return;
        }
        // Delivered by this server's terminal as soon as its session is live.
        queueCommand(serverId, command, 'ai');
    });

    const stopAll = useStableCallback(() => {
        stream.stop();
        autoRun.controller.stop();
    });

    const fixIt = useFixIt(() => ({ ...requestContext(), history: toHistoryPayload(messagesRef.current) }), target);
    const latestIssueId = terminalIssues.at(-1)?.id ?? null;
    // A suggestion belongs to the issue it was asked for: a newer issue, or
    // dismissing that one, drops it (and cancels a request in flight).
    const cancelFix = fixIt.cancel;
    useEffect(() => {
        cancelFix();
    }, [latestIssueId, cancelFix]);
    const fixItState = fixIt.state.status !== 'idle' && fixIt.state.issueId === latestIssueId ? fixIt.state : FIX_IT_IDLE;

    const clearConversation = async () => {
        const ok = await confirm({ title: t('chat.clear.title'), message: t('chat.clear.message'), confirmLabel: t('chat.clear.confirm'), tone: 'danger' });
        if (!ok) return;
        stopAll();
        fixIt.cancel();
        try {
            await history.clear();
        } catch (error) {
            toast.error(t('chat.messages.saveFailed'), error instanceof Error ? error.message : undefined);
        }
    };

    const toggleAutoRun = () => {
        if (autoRunState.enabled) {
            autoRun.controller.disable();
            appendNotice(notice('chat.notices.autoRunDisabled'));
        } else {
            setAutoRunDialogOpen(true);
        }
    };

    const confirmAutoRun = () => {
        setAutoRunDialogOpen(false);
        autoRun.controller.enable();
        appendNotice(notice('chat.notices.autoRunEnabled', { name: serverName }, 'warning'));
    };

    // The panel stays mounted while closed or while another server is shown
    // (a draft or an answer in progress survive), but Auto-Run does not, as
    // its confirmation promises: nothing may be typed into the terminal while
    // nobody sees the chat, and an approval card would wait there unseen.
    const autoRunController = autoRun.controller;
    const stopStream = stream.stop;
    useEffect(() => {
        if (onScreen || !autoRunController.getState().enabled) return;
        if (streamPurposeRef.current === 'autorun-step') stopStream();
        autoRunController.disable();
        appendNotice(notice(chatOpen ? 'chat.notices.autoRunSwitched' : 'chat.notices.autoRunClosed'));
    }, [onScreen, chatOpen, autoRunController, stopStream, appendNotice]);

    // A step the terminal did not type ends the chain at once.
    useEffect(() => onCommandUndelivered((report) => {
        if (report.serverId !== serverId || report.source !== 'ai-autorun') return;
        if (report.reason === 'full-screen' || report.reason === 'no-prompt' || report.reason === 'not-connected' || report.reason === 'container-shell') {
            autoRunController.notTyped(report.reason);
        }
    }), [serverId, autoRunController]);

    // App-wide: every open chat switches to it (useChatModel).
    const changeModel = async (next: string) => {
        chooseChatModel(next);
        try {
            await api.post('/api/config/model', { model: next });
        } catch {
            toast.warning(t('chat.model.saveFailed'));
        }
    };

    // Requests from this server's terminal ("Ask AI", the inline "!" button
    // of the latest issue) and from the "Ask AI" buttons of the other panels
    // (a diagnosis: see attachContext).
    const requestFix = fixIt.request;
    useEffect(() => {
        if (!chatRequest || chatRequest.serverId !== serverId) return;
        if (!consumeChatRequest(chatRequest.id)) return;
        if (chatRequest.kind === 'context') {
            if (Date.now() - chatRequest.requestedAt <= CONTEXT_REQUEST_TTL_MS) attachContext(chatRequest.attachment, chatRequest.prompt);
        } else if (chatRequest.kind === 'prompt') {
            setInput(chatRequest.prompt);
            focusComposer();
        } else if (latestIssueId) {
            void requestFix(latestIssueId);
        }
    }, [chatRequest, serverId, consumeChatRequest, requestFix, latestIssueId, attachContext]);

    const lastTurn = [...messages].reverse().find((message) => message.kind !== 'notice');
    const regenerableId = !busy && lastTurn && (lastTurn.kind === 'error' || (lastTurn.kind === 'chat' && lastTurn.role === 'assistant')) ? lastTurn.id : null;
    const recommended = findModel(model)?.recommended === true;
    const osDetail = server?.osDetail ?? server?.os_detail;
    // The terminal tab the chat reads (and Run types into) is a container's shell.
    const containerShell = useAppStore((state) => (serverId == null ? undefined : focusedTerminalAttach(state.terminalSessions[serverId])));

    return (
        <div ref={panelRef} className="relative flex h-full flex-col bg-ink-850/40 text-zinc-300">
            <ChatHeader onClear={clearConversation} canClear={messages.length > 0 || busy} />

            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/5 bg-ink-900/50 px-3 py-2">
                <div className="flex min-w-0 items-center gap-1.5">
                    {recommended && (
                        <span className="flex shrink-0 items-center justify-center rounded-md border border-amber-500/30 bg-amber-500/15 px-1.5 py-1 text-amber-300" title={t('chat.model.recommended')}>
                            <Star aria-hidden="true" className="h-3 w-3 fill-current" />
                            <span className="sr-only">{t('chat.model.recommended')}</span>
                        </span>
                    )}
                    <div className="min-w-0" aria-label={t('chat.model.label')} role="group">
                        <Select
                            value={model}
                            onChange={changeModel}
                            options={MODEL_OPTIONS}
                            className={cn('min-w-0 max-w-[210px] py-1.5 text-[11px]', recommended && 'border-amber-500/40')}
                        />
                    </div>
                </div>
                <AutoRunToggle enabled={autoRunState.enabled} onToggle={toggleAutoRun} disabled={!hasShell} />
            </div>

            <div className="relative min-h-0 flex-1">
                <div
                    ref={listRef}
                    onScroll={scroll.onScroll}
                    role="log"
                    aria-label={t('chat.messages.label')}
                    aria-live="off"
                    className="h-full space-y-5 overflow-y-auto overflow-x-hidden p-4 scrollbar-thin"
                >
                    <div className="flex flex-col items-start gap-1.5">
                        <div className="flex items-center gap-1.5 px-1">
                            <Bot aria-hidden="true" className="h-3 w-3 text-brand-400" />
                            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{t('chat.roles.assistant')}</span>
                        </div>
                        <div className="rounded-xl rounded-tl-sm border border-white/5 bg-ink-800/60 px-3.5 py-2.5 text-[13px] leading-relaxed">
                            <p>{greeting(t, server, connectionState, terminalIssues.length > 0)}</p>
                            {osDetail && <p className="mt-1 text-[12px] text-zinc-400">{t('chat.greeting.detected', { os: osDetail })}</p>}
                            {containerShell && (
                                <p data-container-shell className="mt-1 text-[12px] text-amber-200/90">
                                    {t('chat.greeting.containerShell', {
                                        container: containerShell.container,
                                        // W8-T2: a pod's container reads "(pod <namespace>/<pod>)".
                                        engine: containerShell.kind === 'pod' ? `pod ${containerShell.namespace}/${containerShell.pod}` : containerShell.engine
                                    })}
                                </p>
                            )}
                        </div>
                    </div>

                    {history.status === 'loading' && <p className="px-1 text-[12px] text-zinc-500">{t('chat.messages.loadingHistory')}</p>}
                    {history.status === 'unavailable' && <p className="px-1 text-[12px] text-amber-300/80">{t('chat.messages.historyUnavailable')}</p>}

                    {rendered.visible.map((message) => (
                        <MessageItem
                            key={message.id}
                            message={message}
                            target={target}
                            serverName={serverName}
                            onRun={hasShell ? runCommand : undefined}
                            onRegenerate={message.id === regenerableId ? regenerate : undefined}
                        />
                    ))}

                    {stream.live && (
                        <div className="flex max-w-[92%] flex-col items-start gap-1.5">
                            <div className="flex items-center gap-1.5 px-1">
                                <Bot aria-hidden="true" className="h-3 w-3 text-brand-400" />
                                <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{t('chat.roles.assistant')}</span>
                            </div>
                            <div className="w-full rounded-xl rounded-tl-sm border border-white/5 bg-ink-800/60 px-3.5 py-2.5">
                                {stream.live.text ? (
                                    <MessageBody content={stream.live.text} state="streaming" target={target} serverName={serverName} />
                                ) : (
                                    <div className="flex items-center gap-1.5 py-0.5">
                                        <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400" />
                                        <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400 [animation-delay:160ms]" />
                                        <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400 [animation-delay:320ms]" />
                                        <span className="sr-only">{t('chat.messages.thinking')}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {scroll.showJump && (
                    <button
                        type="button"
                        onClick={() => scroll.scrollToBottom('smooth')}
                        className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-ink-700/95 px-3 py-1 text-[11px] font-medium text-zinc-200 shadow-panel backdrop-blur transition hover:bg-ink-600 focus-ring animate-fade-in"
                    >
                        <ArrowDown aria-hidden="true" className="h-3 w-3" /> {t('chat.messages.jumpToLatest')}
                    </button>
                )}
            </div>

            <div aria-live="polite" className="sr-only">
                {stream.isStreaming ? t('chat.messages.answering') : announcement}
            </div>

            <AutoRunStatus
                state={autoRunState}
                serverName={serverName}
                onStop={stopAll}
                onApprove={autoRun.controller.approve}
                onSkip={autoRun.controller.skip}
            />

            <div className="shrink-0 border-t border-white/5 bg-ink-850/70 p-3">
                {disclosure.visible && disclosure.route && <ProviderNotice route={disclosure.route} onAcknowledge={disclosure.acknowledge} />}
                <Composer
                    ref={composerRef}
                    value={input}
                    onChange={setInput}
                    onSend={send}
                    onStop={stopAll}
                    busy={busy}
                    maxHeight={composerMaxHeight}
                    canSendEmpty={pendingAttachment?.status === 'ready'}
                    waitReason={pendingAttachment?.status === 'collecting'
                        ? t('chat.evidence.waiting')
                        : pendingAttachment?.status === 'error' ? t('chat.evidence.blocked') : undefined}
                    attachment={pendingAttachment && (
                        // Another attachment starts folded.
                        <AttachmentCard
                            key={pendingAttachment.id}
                            pending={pendingAttachment}
                            serverName={serverName}
                            onRemove={attachment.remove}
                            onRetry={() => attachFor(pendingAttachment.attachment)}
                        />
                    )}
                />

                <IssueCard
                    issues={terminalIssues}
                    fixIt={fixItState}
                    onDismiss={(id) => onDismissTerminalIssue?.(id)}
                    onClearAll={() => onClearTerminalIssues?.()}
                    onAnalyze={() => {
                        setInput(t('chat.issues.analyzePrompt'));
                        focusComposer();
                    }}
                    onFix={() => {
                        if (latestIssueId) void fixIt.request(latestIssueId);
                    }}
                    onCancelFix={fixIt.cancel}
                    onRun={runCommand}
                />

                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-1 text-[11px] text-zinc-400">
                    <span className="min-w-0 max-w-full truncate">{server ? t('chat.composer.context', { name: serverName }) : t('chat.composer.noContext')}</span>
                    <span>{t('chat.composer.hint')}</span>
                </div>
            </div>

            <AutoRunConfirmDialog open={autoRunDialogOpen} serverName={serverName} onConfirm={confirmAutoRun} onCancel={() => setAutoRunDialogOpen(false)} />
        </div>
    );
}
