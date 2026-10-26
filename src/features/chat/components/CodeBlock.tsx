import { memo, useEffect, useRef, useState } from 'react';
import { Check, Copy, FileCode, Play, Terminal } from 'lucide-react';
import { useT } from '@/i18n';
import { commandForBlock, isRunnableLanguage, type CodeSegment, type RunTarget } from '../lib/fences';
import { copyText } from '@/lib/clipboard';

// Primitive props, so a block whose text did not change skips re-rendering
// while the rest of its answer streams.
type CodeBlockProps = {
    lang: string;
    code: string;
    closed: boolean;
    // The answer is still streaming (an open block may still close).
    streaming?: boolean;
    target: RunTarget;
    // Absent while the answer is still streaming or when no server is open.
    onRun?: (command: string) => void;
    serverName?: string;
};

export const CodeBlock = memo(function CodeBlock({ lang, code, closed, streaming = false, target, onRun, serverName }: CodeBlockProps) {
    const block: CodeSegment = { type: 'code', lang, code, closed };
    const t = useT();
    const [copied, setCopied] = useState(false);
    const resetTimer = useRef<number | null>(null);
    const runnable = isRunnableLanguage(block.lang, target);
    const Icon = runnable ? Terminal : FileCode;

    useEffect(() => () => {
        if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    }, []);

    const copy = async () => {
        try {
            await copyText(block.code);
            setCopied(true);
            if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
            resetTimer.current = window.setTimeout(() => setCopied(false), 1400);
        } catch {
            setCopied(false);
        }
    };

    return (
        <div className="my-2 overflow-hidden rounded-lg border border-white/10 bg-ink-900">
            <div className="flex items-center justify-between gap-2 border-b border-white/5 bg-white/[0.03] px-2.5 py-1">
                <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-zinc-400">
                    <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />
                    <span className="truncate">{block.lang || t('chat.code.text')}</span>
                    {!runnable && block.closed && (
                        <span className="normal-case tracking-normal text-zinc-500" title={t('chat.code.referenceTitle')}>
                            · {t('chat.code.reference')}
                        </span>
                    )}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        onClick={copy}
                        aria-label={t('chat.code.copyLabel')}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 focus-ring"
                    >
                        {copied ? <Check aria-hidden="true" className="h-3 w-3 text-emerald-400" /> : <Copy aria-hidden="true" className="h-3 w-3" />}
                        <span aria-live="polite">{copied ? t('chat.code.copied') : t('chat.code.copy')}</span>
                    </button>
                    {runnable && block.closed && onRun && (
                        <button
                            type="button"
                            onClick={() => onRun(commandForBlock(block))}
                            title={t('chat.code.runTitle', { name: serverName ?? '' })}
                            // Solid primary colours: a tinted chip fell below 4.5:1 on the light theme.
                            className="flex items-center gap-1 rounded bg-brand-500 px-1.5 py-0.5 text-[11px] font-medium text-on-brand transition hover:bg-brand-400 focus-ring"
                        >
                            <Play aria-hidden="true" className="h-3 w-3" /> {t('chat.code.run')}
                        </button>
                    )}
                </div>
            </div>
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap p-2.5 font-mono text-xs leading-relaxed text-zinc-200 scrollbar-thin [overflow-wrap:anywhere]">
                <code>{block.code}</code>
            </pre>
            {!block.closed && streaming && (
                <div className="border-t border-white/5 px-2.5 py-1 text-[11px] text-zinc-500">{t('chat.code.pending')}</div>
            )}
        </div>
    );
});
