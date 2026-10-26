import { forwardRef, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Send, Square } from 'lucide-react';
import { MAX_CHAT_MESSAGE_CHARS } from '@shared/models';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';

type ComposerProps = {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    // A request or an Auto-Run chain is in flight: the button stops it.
    busy: boolean;
    // Tallest the box may grow, in px (the chat panel sizes it).
    maxHeight: number;
    // Shown above the box (the attachment of a diagnosis).
    attachment?: ReactNode;
    // Something besides the text can be sent (a ready attachment).
    canSendEmpty?: boolean;
    // Sending has to wait, and why (the evidence is still being collected).
    waitReason?: string;
};

// The message box: grows with its content up to `maxHeight` (then scrolls
// with a visible scrollbar), Enter sends unless an IME composition is in
// progress, Shift+Enter adds a line.
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer({ value, onChange, onSend, onStop, busy, maxHeight, attachment, canSendEmpty, waitReason }, ref) {
    const t = useT();
    const waitId = useId();
    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    const tooLong = value.length > MAX_CHAT_MESSAGE_CHARS;
    const canSend = (value.trim().length > 0 || canSendEmpty === true) && !tooLong && !waitReason;

    useLayoutEffect(() => {
        const el = innerRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
        el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }, [value, maxHeight]);

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        // Enter confirms an IME candidate (CJK, accents) instead of sending.
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (!busy && canSend) onSend();
    };

    return (
        <div>
            {attachment}
            <div className="relative">
                <textarea
                    ref={(node) => {
                        innerRef.current = node;
                        if (typeof ref === 'function') ref(node);
                        else if (ref) ref.current = node;
                    }}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    onKeyDown={onKeyDown}
                    rows={3}
                    aria-label={t('chat.composer.label')}
                    aria-invalid={tooLong || undefined}
                    placeholder={t('chat.composer.placeholder')}
                    style={{ maxHeight }}
                    className={cn(
                        'block min-h-[78px] w-full resize-none rounded-xl border bg-ink-900 p-3 pr-11 text-sm text-zinc-200 scrollbar-thin focus:outline-none',
                        tooLong ? 'border-rose-500/60' : 'border-white/10 focus:border-brand-500/60'
                    )}
                />
                {busy ? (
                    <button
                        type="button"
                        onClick={onStop}
                        aria-label={t('chat.composer.stop')}
                        title={t('chat.composer.stop')}
                        className="absolute bottom-2 right-2 flex items-center justify-center rounded-lg bg-rose-600 p-2 text-fixed-white transition hover:bg-rose-700 focus-ring"
                    >
                        <Square aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={onSend}
                        disabled={!canSend}
                        aria-label={t('chat.composer.send')}
                        aria-describedby={waitReason ? waitId : undefined}
                        title={waitReason ?? t('chat.composer.send')}
                        className="absolute bottom-2 right-2 flex items-center justify-center rounded-lg bg-brand-500 p-2 text-on-brand transition hover:bg-brand-400 focus-ring disabled:bg-white/5 disabled:text-zinc-400 disabled:opacity-30"
                    >
                        <Send aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                )}
                {waitReason && <span id={waitId} hidden>{waitReason}</span>}
            </div>
            {tooLong && (
                <p className="mt-1 px-1 text-[11px] text-rose-300">
                    {t('chat.composer.tooLong', { count: value.length, max: MAX_CHAT_MESSAGE_CHARS })}
                </p>
            )}
        </div>
    );
});
