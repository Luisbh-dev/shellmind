import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, RotateCw, ShieldAlert } from 'lucide-react';
import type { HealthResponse, SessionResponse } from '@shared/types';
import logo from '@/assets/logo.svg';
import { Button, PasswordInput, Spinner, useOverlay } from '@/components/ui';
import { holdAppInert } from '@/components/ui/appInert';
import { restoreFocus, trapTab } from '@/components/ui/focus';
import { useT } from '@/i18n';
import { ApiError, api, forgetAuthToken, getApiBase, getAuthToken, onUnauthorized, setAuthToken } from '@/lib/api';
import { reconnectRefusedSockets } from '@/lib/refusedSockets';

// Renders the app once the backend is up and accepts our session token.
// While the backend starts (Electron forks it, `npm start` compiles it) a
// splash polls GET /api/health with backoff; a 401 on the authenticated probe
// asks for the access token instead. A token that stops working later (the
// backend restarted with a new one) does not take the app down: the token
// form opens over it, and every terminal, editor buffer and chat draft is
// still there once the app is unlocked again.

type Phase =
    | { kind: 'connecting'; attempt: number }
    | { kind: 'blocked'; reason: string }
    | { kind: 'token'; notice?: 'auth.expired' }
    | { kind: 'ready' };

// The splash shows the backend address and a retry button after this many
// failed polls.
const PATIENCE_ATTEMPTS = 6;

export const defaultRetryDelay = (attempt: number) => Math.min(250 * 2 ** attempt, 4000);

interface AccessGateProps {
    children: ReactNode;
    retryDelay?: (attempt: number) => number;
}

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });

export function AccessGate({ children, retryDelay = defaultRetryDelay }: AccessGateProps) {
    const [phase, setPhase] = useState<Phase>({ kind: 'connecting', attempt: 0 });
    const [run, setRun] = useState(0);
    const restart = useCallback(() => setRun((value) => value + 1), []);

    // Wait for the backend, then check the token.
    useEffect(() => {
        const controller = new AbortController();
        const { signal } = controller;

        (async () => {
            setPhase({ kind: 'connecting', attempt: 0 });
            for (let attempt = 0; ; attempt++) {
                try {
                    await api.get<HealthResponse>('/api/health', { signal });
                    break;
                } catch (error) {
                    if (signal.aborted) return;
                    if (error instanceof ApiError && error.status === 403) {
                        setPhase({ kind: 'blocked', reason: error.message });
                        return;
                    }
                    setPhase({ kind: 'connecting', attempt: attempt + 1 });
                    await sleep(retryDelay(attempt), signal);
                    if (signal.aborted) return;
                }
            }

            // Each refused token is dropped and the next stored one tried (a
            // launch token, the dev server's, a remembered one) before asking.
            for (;;) {
                const token = getAuthToken();
                try {
                    await api.get<SessionResponse>('/api/session', { signal, token });
                    if (!signal.aborted) setPhase({ kind: 'ready' });
                    return;
                } catch (error) {
                    if (signal.aborted) return;
                    if (error instanceof ApiError && error.status === 401) {
                        if (token) forgetAuthToken(token);
                        const next = getAuthToken();
                        if (next && next !== token) continue;
                        setPhase({ kind: 'token', notice: token ? 'auth.expired' : undefined });
                        return;
                    }
                    // The backend went away between the two requests: start over.
                    await sleep(retryDelay(0), signal);
                    if (!signal.aborted) restart();
                    return;
                }
            }
        })();

        return () => controller.abort();
    }, [run, restart, retryDelay]);

    const ready = phase.kind === 'ready';
    const readyRef = useRef(ready);
    useEffect(() => {
        readyRef.current = ready;
    }, [ready]);

    // The app mounts the first time the gate opens and stays mounted after.
    const [opened, setOpened] = useState(false);
    if (ready && !opened) setOpened(true);

    // A token that stops working later (the backend restarted with a new one):
    // an HTTP 401, or a socket refused at its handshake (src/lib/socket.ts).
    // Refusals while the gate itself is checking, and of a token that is no
    // longer the current one (a request still in flight), are not news.
    const interrupted = useRef(false);
    useEffect(() => onUnauthorized((rejected) => {
        if (!readyRef.current || rejected !== getAuthToken()) return;
        readyRef.current = false;
        interrupted.current = true;
        if (rejected) forgetAuthToken(rejected);
        if (getAuthToken()) restart();
        else setPhase({ kind: 'token', notice: 'auth.expired' });
    }), [restart]);

    // Unlocked again: the sockets the backend refused meanwhile (socket.io
    // does not retry those) connect with the new token.
    useEffect(() => {
        if (!ready || !interrupted.current) return;
        interrupted.current = false;
        reconnectRefusedSockets();
    }, [ready]);

    const gate = <GateContent phase={phase} restart={restart} kept={opened} onAccepted={() => setPhase({ kind: 'ready' })} />;

    if (!opened) {
        return <div className="flex h-screen w-screen items-center justify-center bg-ink-900 p-4 text-zinc-300">{gate}</div>;
    }
    return (
        <>
            {children}
            {!ready && <GateOverlay label={phase.kind === 'token' ? 'access-gate-title' : undefined}>{gate}</GateOverlay>}
        </>
    );
}

// `kept`: the app is open behind the gate.
function GateContent({ phase, restart, kept, onAccepted }: { phase: Phase; restart: () => void; kept: boolean; onAccepted: () => void }) {
    const t = useT();
    if (phase.kind === 'ready') return null;
    if (phase.kind === 'token') return <TokenForm notice={phase.notice} kept={kept} onAccepted={onAccepted} />;
    return (
        <div className="flex max-w-sm flex-col items-center gap-4 text-center" role="status" aria-live="polite">
            <img src={logo} alt="" className="h-12 w-12 opacity-90" />
            {phase.kind === 'blocked' ? (
                <>
                    <ShieldAlert className="h-5 w-5 text-rose-300" aria-hidden="true" />
                    <p className="text-sm text-zinc-200">{t('auth.blocked', { reason: phase.reason })}</p>
                    <p className="text-xs text-zinc-500">{t('auth.blockedHint')}</p>
                    <Button size="sm" onClick={restart}>
                        <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('auth.retryNow')}
                    </Button>
                </>
            ) : (
                <>
                    <div className="flex items-center gap-2 text-sm text-zinc-300">
                        <Spinner className="h-4 w-4 text-brand-400" />
                        {t('auth.starting')}
                    </div>
                    {phase.attempt >= PATIENCE_ATTEMPTS && (
                        <>
                            <p className="text-xs text-zinc-500">{t('auth.waiting', { url: getApiBase() })}</p>
                            <Button size="sm" variant="ghost" onClick={restart}>
                                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('auth.retryNow')}
                            </Button>
                        </>
                    )}
                </>
            )}
        </div>
    );
}

// The gate over a running app: everything behind it stays as it was but is
// inert, the app's shortcuts are blocked (it is the topmost overlay) and
// Escape does not dismiss it. Focus returns where it was once it closes.
function GateOverlay({ children, label }: { children: ReactNode; label?: string }) {
    const t = useT();
    const panelRef = useRef<HTMLDivElement>(null);
    const isTop = useOverlay(true, () => undefined);
    // Taken while rendering: the token field focuses itself before this
    // component's effects run.
    const [opener] = useState(() => document.activeElement);

    useEffect(() => {
        const release = holdAppInert();
        const panel = panelRef.current;
        if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
        // Tab stays inside.
        const onKeyDown = (event: KeyboardEvent) => {
            if (panel && isTop()) trapTab(event, panel);
        };
        panel?.addEventListener('keydown', onKeyDown);
        return () => {
            panel?.removeEventListener('keydown', onKeyDown);
            release();
            restoreFocus(opener);
        };
    }, [opener, isTop]);

    return createPortal(
        <div role="presentation" className="fixed inset-0 z-[80] flex items-center justify-center bg-scrim/70 p-4 backdrop-blur-sm animate-fade-in">
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={label}
                aria-label={label ? undefined : t('auth.locked')}
                tabIndex={-1}
                className="flex w-full max-w-md justify-center text-zinc-300 outline-none"
            >
                {children}
            </div>
        </div>,
        document.body
    );
}

function TokenForm({ notice, kept, onAccepted }: { notice?: 'auth.expired'; kept: boolean; onAccepted: () => void }) {
    const t = useT();
    const [token, setToken] = useState('');
    const [remember, setRemember] = useState(false);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const message = error ?? (notice && t(notice));

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const value = token.trim();
        if (!value || checking) return;
        setChecking(true);
        setError(undefined);
        try {
            // Checked before it is stored, so a typo never replaces a token.
            await api.get<SessionResponse>('/api/session', { token: value });
            setAuthToken(value, { remember });
            onAccepted();
        } catch (failure) {
            setError(failure instanceof ApiError && failure.status === 401
                ? t('auth.rejected')
                : t('auth.failed', { message: failure instanceof Error ? failure.message : String(failure) }));
            setChecking(false);
        }
    };

    return (
        <form
            onSubmit={submit}
            className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-ink-800 shadow-panel"
            aria-labelledby="access-gate-title"
        >
            <div className="flex items-start gap-3 border-b border-white/5 px-5 py-4">
                <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-brand-400" aria-hidden="true" />
                <div>
                    <h1 id="access-gate-title" className="text-sm font-semibold text-zinc-100">{t('auth.title')}</h1>
                    <p className="mt-1 text-xs text-zinc-400">{t('auth.description')}</p>
                    {kept && <p className="mt-1.5 text-xs text-zinc-300">{t('auth.keptHint')}</p>}
                </div>
            </div>
            <div className="space-y-3 px-5 py-4">
                <div className="space-y-1.5">
                    <label htmlFor="access-token" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                        {t('auth.tokenLabel')}
                    </label>
                    <PasswordInput
                        ref={inputRef}
                        id="access-token"
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        placeholder={t('auth.tokenPlaceholder')}
                        autoComplete="current-password"
                        spellCheck={false}
                        aria-invalid={message ? true : undefined}
                        aria-describedby={message ? 'access-token-error' : undefined}
                    />
                </div>
                <label className="flex items-start gap-2 text-xs text-zinc-300">
                    <input
                        type="checkbox"
                        checked={remember}
                        onChange={(event) => setRemember(event.target.checked)}
                        className="mt-0.5 accent-brand-500"
                    />
                    <span>
                        {t('auth.remember')}
                        <span className="block text-zinc-500">{t('auth.rememberHint')}</span>
                    </span>
                </label>
                {message && (
                    <p id="access-token-error" role="alert" className="text-xs text-rose-300">{message}</p>
                )}
            </div>
            <div className="flex justify-end border-t border-white/5 bg-white/[0.02] px-5 py-4">
                <Button type="submit" variant="primary" loading={checking} disabled={!token.trim()}>
                    {t('auth.submit')}
                </Button>
            </div>
        </form>
    );
}
