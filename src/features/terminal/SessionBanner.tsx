import { Container, Hourglass, RotateCw, ShieldAlert, Unplug, X } from 'lucide-react';
import type { HostKeyMismatchPayload } from '@shared/protocol';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';

const buttonClass = 'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors focus-ring';

const BANNER_TEXT = {
    disconnected: { title: 'terminal.banner.disconnectedTitle', text: 'terminal.banner.disconnectedText' },
    error: { title: 'terminal.banner.errorTitle', text: 'terminal.banner.errorText' },
    offline: { title: 'terminal.banner.offlineTitle', text: 'terminal.banner.offlineText' }
} as const;

// Shown above the terminal when its session ended or failed, or the backend
// cannot be reached. It does not cover the output: the last lines stay
// readable, scrollable and copyable. `detail` is the backend's own text of
// the failure, when it says more than `error`.
export function SessionBanner({
    state,
    error,
    detail,
    onReconnect,
    onDismiss
}: {
    state: 'disconnected' | 'error' | 'offline';
    error: string;
    detail?: string;
    onReconnect: () => void;
    onDismiss: () => void;
}) {
    const t = useT();
    const failed = state === 'error';
    const text = BANNER_TEXT[state];
    return (
        <div
            role={failed ? 'alert' : 'status'}
            className={cn(
                'flex shrink-0 items-center gap-3 border-b px-3 py-2 text-xs animate-fade-in',
                failed ? 'border-rose-500/20 bg-rose-500/10 text-rose-100' : 'border-white/5 bg-ink-800 text-zinc-200'
            )}
        >
            <Unplug className={cn('h-4 w-4 shrink-0', failed ? 'text-rose-300' : 'text-zinc-400')} aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <span className="font-semibold">{t(text.title)}</span>
                <span className="ml-2 break-words text-zinc-300">{error || t(text.text)}</span>
                {detail && <span className="mt-0.5 block break-words font-mono text-[11px] text-zinc-400">{detail}</span>}
            </div>
            <button type="button" onClick={onReconnect} className={cn(buttonClass, 'bg-brand-500 text-on-brand hover:bg-brand-400')}>
                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                {t('terminal.banner.reconnect')}
            </button>
            <button
                type="button"
                onClick={onDismiss}
                aria-label={t('terminal.banner.dismiss')}
                title={t('terminal.banner.dismiss')}
                className="shrink-0 rounded-md p-1 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 focus-ring"
            >
                <X className="h-4 w-4" />
            </button>
        </div>
    );
}

// Commands queued by the app wait while a full-screen program holds the
// terminal: the user may type them into it anyway, or drop them.
export function HeldCommandsBanner({ count, onTypeNow, onDiscard }: { count: number; onTypeNow: () => void; onDiscard: () => void }) {
    const t = useT();
    return (
        <div role="status" className="flex shrink-0 items-center gap-3 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-50 animate-fade-in">
            <Hourglass className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
            <p className="min-w-0 flex-1 break-words">
                {count === 1 ? t('terminal.typing.waitingOne') : t('terminal.typing.waitingMany', { count })}
            </p>
            <button type="button" onClick={onTypeNow} className={cn(buttonClass, 'border border-amber-400/40 text-amber-100 hover:bg-amber-500/20')}>
                {t('terminal.typing.typeNow')}
            </button>
            <button type="button" onClick={onDiscard} className={cn(buttonClass, 'text-amber-100 hover:bg-white/5')}>
                {t('terminal.typing.discard')}
            </button>
        </div>
    );
}

// Commands queued for the server (AI chat, snippets...) wait while its
// focused tab is a shell inside a container: they were meant for the server,
// so the user runs them there, types them into the container, or drops them.
export function ContainerHeldBanner({
    count,
    server,
    container,
    canType,
    onRunOnServer,
    onTypeHere,
    onDiscard
}: {
    count: number;
    server: string;
    container: string;
    // The container's shell is connected (it can take them).
    canType: boolean;
    onRunOnServer: () => void;
    onTypeHere: () => void;
    onDiscard: () => void;
}) {
    const t = useT();
    return (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-sky-500/20 bg-sky-500/10 px-3 py-2 text-xs text-sky-50 animate-fade-in">
            <Container className="h-4 w-4 shrink-0 text-sky-300" aria-hidden="true" />
            <p className="min-w-0 flex-1 basis-64 break-words">
                {count === 1
                    ? t('terminal.typing.containerWaitingOne', { server, container })
                    : t('terminal.typing.containerWaitingMany', { count, server, container })}
            </p>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <button type="button" onClick={onRunOnServer} className={cn(buttonClass, 'bg-sky-500/25 text-sky-50 hover:bg-sky-500/35')}>
                    {t('terminal.typing.runOnServer', { server })}
                </button>
                {canType && (
                    <button type="button" onClick={onTypeHere} className={cn(buttonClass, 'border border-sky-400/40 text-sky-100 hover:bg-sky-500/20')}>
                        {t('terminal.typing.typeInContainer')}
                    </button>
                )}
                <button type="button" onClick={onDiscard} className={cn(buttonClass, 'text-sky-100 hover:bg-white/5')}>
                    {t('terminal.typing.discard')}
                </button>
            </div>
        </div>
    );
}

// The server presented another host key than the pinned one: both
// fingerprints, and the way to trust the new key once the user checked it.
export function HostKeyBanner({
    mismatch,
    busy,
    onTrust,
    onDismiss
}: {
    mismatch: HostKeyMismatchPayload;
    busy: boolean;
    onTrust: () => void;
    onDismiss: () => void;
}) {
    const t = useT();
    return (
        <div role="alert" className="shrink-0 border-b border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-50 animate-fade-in">
            <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="font-semibold">
                        {mismatch.via
                            ? t('terminal.hostKey.titleVia', { host: mismatch.host, port: mismatch.port, via: mismatch.via.split('>').join(' → ') })
                            : t('terminal.hostKey.title', { host: mismatch.host, port: mismatch.port })}
                    </p>
                    <p className="text-amber-100/80">{t('terminal.hostKey.text')}</p>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
                        <dt className="font-sans text-amber-200/80">{t('terminal.hostKey.expected', { keyType: mismatch.keyType })}</dt>
                        <dd className="break-all">{mismatch.expected}</dd>
                        <dt className="font-sans text-amber-200/80">{t('terminal.hostKey.actual')}</dt>
                        <dd className="break-all">{mismatch.actual}</dd>
                    </dl>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    <button
                        type="button"
                        onClick={onTrust}
                        disabled={busy}
                        className={cn(buttonClass, 'border border-amber-400/40 text-amber-100 hover:bg-amber-500/20 disabled:opacity-50')}
                    >
                        {t('terminal.hostKey.trust')}
                    </button>
                    <button
                        type="button"
                        onClick={onDismiss}
                        aria-label={t('terminal.banner.dismiss')}
                        title={t('terminal.banner.dismiss')}
                        className="rounded-md p-1 text-amber-200/80 hover:bg-white/5 hover:text-amber-50 focus-ring"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            </div>
        </div>
    );
}
