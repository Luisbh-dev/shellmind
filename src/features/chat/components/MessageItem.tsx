import { memo, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, Check, Copy, Info, RefreshCw, TerminalSquare, User } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';
import { Trans } from '@/i18n/Trans';
import type { RunTarget } from '../lib/fences';
import type { ChatMessage } from '../types';
import { SentEvidence } from './Evidence';
import { MessageBody } from './MessageBody';
import { copyText } from '@/lib/clipboard';

type MessageItemProps = {
    message: ChatMessage;
    target: RunTarget;
    serverName?: string;
    onRun?: (command: string) => void;
    // Shown on the last answer (regenerate) and on errors (retry).
    onRegenerate?: () => void;
};

// A bubble out of view skips layout and paint. A restored conversation adds
// its older messages above the view, which otherwise lays every message out
// again for each batch (~30 ms with 100 answers). Paint containment clips at
// the bubble's padding box, so the focus rings of its links and buttons, well
// inside that padding, are not cut off.
const OFFSCREEN_SKIP ='[content-visibility:auto] [contain-intrinsic-size:auto_8rem]';

function RoleLabel({ author }: { author: ChatMessage['role'] }) {
    const t = useT();
    return (
        <div className="flex items-center gap-1.5 px-1">
            {author === 'assistant'
                ? <Bot aria-hidden="true" className="h-3 w-3 text-brand-400" />
                : <User aria-hidden="true" className="h-3 w-3 text-zinc-400" />}
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{t(`chat.roles.${author}`)}</span>
        </div>
    );
}

function CopyButton({ text }: { text: string }) {
    const t = useT();
    const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const timer = useRef<number | null>(null);
    useEffect(() => () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
    }, []);

    const copy = async () => {
        try {
            await copyText(text);
            setState('copied');
        } catch {
            setState('failed');
        }
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setState('idle'), 1400);
    };

    return (
        <button type="button" onClick={copy} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 focus-ring">
            {state === 'copied' ? <Check aria-hidden="true" className="h-3 w-3 text-emerald-400" /> : <Copy aria-hidden="true" className="h-3 w-3" />}
            <span aria-live="polite">
                {state === 'copied' ? t('chat.messages.copied') : state === 'failed' ? t('chat.messages.copyFailed') : t('chat.messages.copy')}
            </span>
        </button>
    );
}

function CommandOutput({ message }: { message: ChatMessage }) {
    const t = useT();
    const lines = message.content.replace(/\n$/, '').split('\n').length;
    const command = (message.command ?? '').split('\n')[0];
    return (
        <div className="ml-auto flex w-full max-w-[92%] flex-col items-end gap-1.5">
            <RoleLabel author="user" />
            <details className="group/output w-full rounded-xl border border-white/10 bg-ink-900/80">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-[12px] text-zinc-300 hover:bg-white/[0.03] focus-ring [&::-webkit-details-marker]:hidden">
                    <TerminalSquare aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-brand-400" />
                    <span className="min-w-0 flex-1 truncate">
                        <Trans k="chat.messages.commandOutput" values={{ command: <code className="font-mono text-zinc-100">{command}</code> }} />
                    </span>
                    {message.stillRunning && <span className="shrink-0 text-[11px] text-amber-300">{t('chat.messages.stillRunning')}</span>}
                    <span className="shrink-0 text-[11px] text-zinc-500">{t('chat.messages.lines', { count: lines })}</span>
                </summary>
                {/* Terminal output is never rendered as Markdown. */}
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-white/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-300 scrollbar-thin [overflow-wrap:anywhere]">
                    {message.content}
                </pre>
            </details>
        </div>
    );
}

export const MessageItem = memo(function MessageItem({ message, target, serverName, onRun, onRegenerate }: MessageItemProps) {
    const t = useT();

    if (message.kind === 'notice') {
        const Icon = message.tone === 'warning' ? AlertTriangle : Info;
        return (
            <div className={cn(
                'mx-auto flex max-w-[92%] items-start gap-2 rounded-lg px-3 py-1.5 text-[12px] leading-snug',
                message.tone === 'warning' ? 'bg-amber-500/10 text-amber-200' : 'bg-white/[0.03] text-zinc-400'
            )}>
                <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{message.noticeKey ? t(message.noticeKey, message.noticeParams) : message.content}</span>
            </div>
        );
    }

    if (message.kind === 'error') {
        return (
            <div role="alert" className="flex max-w-[92%] items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
                <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 break-words">{message.noticeKey ? t(message.noticeKey, message.noticeParams) : message.content}</span>
                {onRegenerate && (
                    <button type="button" onClick={onRegenerate} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-rose-100 transition hover:bg-rose-500/20 focus-ring">
                        <RefreshCw aria-hidden="true" className="h-3 w-3" /> {t('chat.messages.retry')}
                    </button>
                )}
            </div>
        );
    }

    if (message.kind === 'command-output') return <CommandOutput message={message} />;

    if (message.role === 'user') {
        return (
            <div className="ml-auto flex max-w-[92%] flex-col items-end gap-1.5">
                <RoleLabel author="user" />
                <div className={cn('w-full whitespace-pre-wrap break-words rounded-xl rounded-tr-sm border border-white/10 bg-ink-650 px-3.5 py-2.5 text-[13px] leading-relaxed text-zinc-100', OFFSCREEN_SKIP)}>
                    {message.content}
                </div>
                {message.evidence && <SentEvidence evidence={message.evidence} />}
            </div>
        );
    }

    return (
        <div className="group flex max-w-[92%] flex-col items-start gap-1.5">
            <RoleLabel author="assistant" />
            <div className={cn('w-full rounded-xl rounded-tl-sm border border-white/5 bg-ink-800/60 px-3.5 py-2.5', OFFSCREEN_SKIP)}>
                <MessageBody
                    content={message.content}
                    state={message.stopped || message.stopReason === 'max_tokens' ? 'partial' : 'complete'}
                    target={target}
                    onRun={onRun}
                    serverName={serverName}
                />
                {(message.stopped || message.stopReason === 'max_tokens') && (
                    <p className="mt-2 text-[11px] italic text-amber-300/80">
                        {message.stopped ? t('chat.messages.stopped') : t('chat.messages.cutOff')}
                    </p>
                )}
            </div>
            <div className="flex items-center gap-1 px-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <CopyButton text={message.content} />
                {onRegenerate && (
                    <button type="button" onClick={onRegenerate} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 focus-ring">
                        <RefreshCw aria-hidden="true" className="h-3 w-3" /> {t('chat.messages.regenerate')}
                    </button>
                )}
            </div>
        </div>
    );
});
