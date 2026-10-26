import { useId, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Copy, Play, RefreshCw, Terminal, X, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';
import type { FixItState } from '../hooks/useFixIt';
import type { TerminalIssue } from '../types';
import { copyText } from '@/lib/clipboard';

type IssueCardProps = {
    issues: TerminalIssue[];
    // The Fix it state of the latest issue.
    fixIt: FixItState;
    onDismiss: (id: string) => void;
    onClearAll: () => void;
    onAnalyze: () => void;
    onFix: () => void;
    onCancelFix: () => void;
    onRun: (command: string) => void;
};

// The latest issue the terminal detected, with "Analyze" (prefills the
// composer) and "Fix it" (one suggested command). A suggestion is only ever a
// runnable shell block from the answer; errors are shown as errors. The card
// can be collapsed to one line (until the next issue) and its details scroll
// within a bounded height, so it never crowds out the conversation.
export function IssueCard({ issues, fixIt, onDismiss, onClearAll, onAnalyze, onFix, onCancelFix, onRun }: IssueCardProps) {
    const t = useT();
    const bodyId = useId();
    const [copied, setCopied] = useState(false);
    const [collapsedId, setCollapsedId] = useState<string | null>(null);
    const latest = issues[issues.length - 1];
    if (!latest) return null;
    const recent = issues.slice(-3).reverse();
    const isError = latest.type === 'error';
    const collapsed = collapsedId === latest.id;
    const fix = () => {
        setCollapsedId(null);
        onFix();
    };

    const copy = async (text: string) => {
        try {
            await copyText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        } catch {
            setCopied(false);
        }
    };

    return (
        <section aria-label={t('chat.issues.title')} className="mt-3 rounded-xl border border-white/10 bg-ink-900/60 px-3 py-2.5">
            {/* The actions sit beside the title and message while both fit on
                one line next to them, and move below the message otherwise
                (the default chat width), so the title never wraps. */}
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                <div className="min-w-0 flex-auto">
                    <button
                        type="button"
                        onClick={() => setCollapsedId(collapsed ? null : latest.id)}
                        aria-expanded={!collapsed}
                        aria-controls={bodyId}
                        title={collapsed ? t('chat.issues.expand') : t('chat.issues.collapse')}
                        className="mb-1 flex max-w-full items-center gap-2 whitespace-nowrap rounded text-[11px] uppercase tracking-wider text-zinc-400 transition-colors hover:text-zinc-200 focus-ring"
                    >
                        <AlertTriangle aria-hidden="true" className={cn('h-3 w-3 shrink-0', isError ? 'text-rose-400' : 'text-amber-400')} />
                        <span className="truncate">{t('chat.issues.title')}</span>
                        <ChevronDown aria-hidden="true" className={cn('h-3 w-3 shrink-0 transition-transform', collapsed && '-rotate-90')} />
                    </button>
                    <div
                        className={cn('break-words text-xs font-medium', collapsed ? 'truncate' : 'max-h-24 overflow-hidden', isError ? 'text-rose-300' : 'text-amber-300')}
                        title={collapsed ? latest.message : undefined}
                    >
                        {latest.message}
                    </div>
                    {!collapsed && latest.details && (
                        <div className="mt-1 max-h-10 overflow-hidden break-words font-mono text-[11px] text-zinc-400">{latest.details}</div>
                    )}
                </div>
                <div className="ml-auto flex shrink-0 gap-1.5">
                    <button
                        type="button"
                        onClick={() => onDismiss(latest.id)}
                        aria-label={t('chat.issues.dismiss')}
                        title={t('chat.issues.dismiss')}
                        className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 focus-ring"
                    >
                        <X aria-hidden="true" className="h-3 w-3" />
                    </button>
                    <button
                        type="button"
                        onClick={onAnalyze}
                        title={t('chat.issues.analyzeTitle')}
                        className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-white/5 hover:text-zinc-100 focus-ring"
                    >
                        <Terminal aria-hidden="true" className="h-3 w-3" /> {t('chat.issues.analyze')}
                    </button>
                    <button
                        type="button"
                        onClick={fix}
                        disabled={fixIt.status === 'loading'}
                        title={t('chat.issues.fixTitle')}
                        className={cn(
                            'flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] transition-colors focus-ring',
                            fixIt.status === 'loading' ? 'border-amber-500/60 bg-amber-500/20 text-amber-200' : 'border-amber-500/40 text-amber-300 hover:bg-amber-500/15'
                        )}
                    >
                        <Zap aria-hidden="true" className="h-3 w-3" /> {t('chat.issues.fix')}
                    </button>
                </div>
            </div>

            {/* The Fix it result comes first: it is what the user acts on. */}
            <div id={bodyId} hidden={collapsed} className="max-h-48 overflow-y-auto scrollbar-thin">
                {fixIt.status === 'loading' && (
                    <div className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
                        <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                        <span className="flex-1">{t('chat.issues.fixing')}</span>
                        <button type="button" onClick={onCancelFix} className="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200 focus-ring">
                            {t('chat.issues.cancel')}
                        </button>
                    </div>
                )}

                {fixIt.status === 'command' && (
                    <div className="mt-2 space-y-2">
                        <div className="rounded-lg border border-white/10 bg-black/60 p-2">
                            <div className="mb-1 text-[11px] uppercase tracking-wider text-zinc-400">{t('chat.issues.suggested')}</div>
                            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-200">{fixIt.command}</pre>
                        </div>
                        <div className="flex gap-2">
                            <button type="button" onClick={() => copy(fixIt.command)} className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-white/5 focus-ring">
                                {copied ? <Check aria-hidden="true" className="h-3 w-3 text-emerald-400" /> : <Copy aria-hidden="true" className="h-3 w-3" />}
                                {copied ? t('chat.issues.copied') : t('chat.issues.copy')}
                            </button>
                            <button type="button" onClick={() => onRun(fixIt.command)} className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-transparent bg-brand-500 px-3 py-1.5 text-[11px] font-medium text-on-brand hover:bg-brand-400 focus-ring">
                                <Play aria-hidden="true" className="h-3 w-3" /> {t('chat.issues.run')}
                            </button>
                        </div>
                    </div>
                )}

                {fixIt.status === 'explanation' && (
                    <div className="mt-2 rounded-lg border border-white/10 bg-black/40 p-2 text-[12px] text-zinc-300">
                        <div className="mb-1 text-[11px] uppercase tracking-wider text-zinc-400">{t('chat.issues.explanation')}</div>
                        <p className="whitespace-pre-wrap break-words">{fixIt.text}</p>
                    </div>
                )}

                {fixIt.status === 'error' && (
                    <div role="alert" className="mt-2 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-[12px] text-rose-200">
                        <span className="min-w-0 flex-1 break-words">{t('chat.issues.failed', { message: t(fixIt.failure.key, fixIt.failure.params) })}</span>
                        <button type="button" onClick={fix} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-rose-500/20 focus-ring">
                            <RefreshCw aria-hidden="true" className="h-3 w-3" /> {t('chat.issues.retry')}
                        </button>
                    </div>
                )}

                {recent.length > 1 && (
                    <div className="mt-2 space-y-1">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] text-zinc-500">{t('chat.issues.recent')}</span>
                            <button type="button" onClick={onClearAll} className="rounded text-[11px] text-zinc-400 transition-colors hover:text-zinc-200 focus-ring">
                                {t('chat.issues.clearAll')}
                            </button>
                        </div>
                        <ul className="space-y-1">
                            {recent.map((issue) => (
                                <li key={issue.id} className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/30 px-2 py-1">
                                    <span className={cn('min-w-0 flex-1 truncate text-[11px] font-medium', issue.type === 'error' ? 'text-rose-300' : 'text-amber-300')} title={issue.message}>
                                        {issue.message}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => onDismiss(issue.id)}
                                        aria-label={t('chat.issues.dismiss')}
                                        className="shrink-0 rounded p-1 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200 focus-ring"
                                    >
                                        <X aria-hidden="true" className="h-3 w-3" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </section>
    );
}
