import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Info, Monitor, Plug, Route, UserRound } from 'lucide-react';
import { effectivePort } from '@shared/ports';
import { formatRdpAddress, type RdpCertificateState, type RdpOptions, type RdpTrustCertificateResult } from '@shared/rdp';
import { Badge, Button, Checkbox, Field, SegmentedControl, Select, Spinner, useToast } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { createSocket } from '@/lib/socket';
import { useElementSize } from '@/lib/useElementSize';
import { useUnsavedGuard } from '@/store/appStore';
import type { WorkspaceServer } from '@/workspace/types';
import { rdpApi } from './api';
import { apiErrorText, CertificateCard, CertificateMismatch, CertificatePending } from './Certificate';
import { RdpConnection, type DesktopSize, type RdpCredentials, type RdpFailure, type RdpStatus } from './connection';
import { describeEndReason, describeFailure, failureMessage } from './errors';
import { isReleaseShortcut } from './keys';
import { NativeLaunch } from './NativeLaunch';
import { joinAccount, PasswordDialog } from './PasswordDialog';
import { fixedSize, readPrefs, RESOLUTIONS, writePrefs, type RdpPrefs } from './prefs';
import { RdpToolbar, type RdpToolbarHandle } from './RdpToolbar';
import { useRdpStore } from './store';

// The toolbar of a live session (h-10): taken off the panel height when the
// first desktop size is chosen, before the toolbar is there.
const TOOLBAR_HEIGHT = 40;
const FALLBACK_DESKTOP: DesktopSize = { width: 1280, height: 720 };
// A resize waits until the panel stops changing size.
const RESIZE_DEBOUNCE_MS = 400;

type Loadable<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; message: string };

type KeyboardLock = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };
const keyboardLock = () => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

// The Remote Desktop tab of a Windows server: the embedded client (IronRDP
// through the backend's gateway) with its toolbar, or the connect screen
// with the options, the pinned certificate and the external client.
export default function RdpPanel({ server, isActive }: { server: WorkspaceServer; isActive: boolean }) {
    const t = useT();
    const toast = useToast();
    const headingId = useId();
    const port = effectivePort(server, 'rdp') ?? 3389;
    const address = formatRdpAddress(server.ip, port);
    const savedAccount = server.username ? joinAccount(server.username, server.domain ?? '') : '';
    const hasPassword = Boolean(server.has_password);

    const [prefs, setPrefs] = useState<RdpPrefs>(() => readPrefs(server.id));
    const updatePrefs = (patch: Partial<RdpPrefs>) => setPrefs((current) => {
        const next = { ...current, ...patch };
        writePrefs(server.id, next);
        return next;
    });

    const [status, setStatus] = useState<RdpStatus | null>(null);
    const connectionRef = useRef<RdpConnection | null>(null);
    const mountRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const toolbarRef = useRef<RdpToolbarHandle>(null);
    const [stageRef, stage] = useElementSize<HTMLDivElement>();
    const [prompt, setPrompt] = useState<{ account: string; error: string | null } | null>(null);
    // How the last attempt signed in (a reconnect does the same).
    const [lastCredentials, setLastCredentials] = useState<{ kind: 'saved' } | { kind: 'typed'; account: string }>({ kind: 'saved' });
    const [trusting, setTrusting] = useState(false);
    const [keyboardCaptured, setKeyboardCaptured] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);
    const [certificate, setCertificate] = useState<Loadable<RdpCertificateState>>({ status: 'loading' });
    const [certificateRevision, setCertificateRevision] = useState(0);
    // Kept by the backend (it holds on every device): "ask for the password each time".
    const [options, setOptions] = useState<Loadable<RdpOptions>>({ status: 'loading' });
    const [savingOptions, setSavingOptions] = useState(false);
    const askEachTime = options.status === 'ready' && options.data.askPassword;

    const live = status?.kind === 'connecting' || status?.kind === 'connected';
    const connected = status?.kind === 'connected' ? status : null;

    // --- connecting ---

    const begin = useCallback((credentials: RdpCredentials) => {
        const mount = mountRef.current;
        if (!mount) return;
        connectionRef.current?.dispose();
        const connection = new RdpConnection(mount, (next) => {
            if (connectionRef.current === connection) setStatus(next);
        });
        connectionRef.current = connection;
        setLastCredentials(credentials.kind === 'typed' ? { kind: 'typed', account: joinAccount(credentials.username, credentials.domain) } : { kind: 'saved' });
        const desktop = fixedSize(prefs.resolution)
            ?? (stage.width >= 200 && stage.height - TOOLBAR_HEIGHT >= 200 ? { width: stage.width, height: stage.height - TOOLBAR_HEIGHT } : FALLBACK_DESKTOP);
        void connection.start({ serverId: server.id, credentials, desktop, clipboard: prefs.clipboard, keyboard: prefs.keyboard });
    }, [prefs.resolution, prefs.clipboard, prefs.keyboard, server.id, stage.width, stage.height]);

    const askPassword = (error: string | null = null) =>
        setPrompt({ account: lastCredentials.kind === 'typed' ? lastCredentials.account : savedAccount, error });

    const connect = () => {
        if (askEachTime || !hasPassword) askPassword();
        else begin({ kind: 'saved' });
    };

    const setAskEachTime = async (ask: boolean) => {
        if (options.status !== 'ready') return;
        const previous = options;
        setOptions({ status: 'ready', data: { ...options.data, askPassword: ask } });
        setSavingOptions(true);
        try {
            setOptions({ status: 'ready', data: await rdpApi.setOptions({ serverId: server.id, askPassword: ask }) });
        } catch (error) {
            setOptions(previous);
            toast.error(t('rdp.options.saveFailed'), apiErrorText(t, error));
        } finally {
            setSavingOptions(false);
        }
    };

    const reconnect = () => {
        if (lastCredentials.kind === 'typed') askPassword();
        else connect();
    };

    const disconnect = () => connectionRef.current?.disconnect();

    useEffect(() => () => {
        connectionRef.current?.dispose();
        connectionRef.current = null;
    }, []);

    // --- what the rest of the app sees ---

    useEffect(() => {
        const store = useRdpStore.getState();
        if (!status || status.kind === 'ended' || status.kind === 'cancelled') store.clearSession(server.id);
        else if (status.kind === 'connected') store.setSession(server.id, { state: 'connected', since: status.since, desktop: status.desktop });
        else store.setSession(server.id, { state: status.kind === 'connecting' ? 'connecting' : 'error' });
    }, [status, server.id]);
    useEffect(() => () => useRdpStore.getState().clearSession(server.id), [server.id]);

    useUnsavedGuard(server.id, live ? () => t('rdp.session.guard') : null);

    // A certificate pinned on this connection: say so once.
    const pinnedNow = connected?.pinnedNow ? connected.certificate : null;
    useEffect(() => {
        if (!pinnedNow) return;
        toast.info(t('rdp.certificate.pinnedNow', { host: address }), t('rdp.certificate.pinnedNowDetail', { fingerprint: pinnedNow.fingerprint }));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per pinned certificate
    }, [pinnedNow?.fingerprint]);

    // The pinned certificate and the options, for the connect screen (read
    // again when it shows: another device may have changed them).
    useEffect(() => {
        if (!isActive || live) return;
        const controller = new AbortController();
        const failed = (error: unknown) => {
            if (!controller.signal.aborted) setCertificate({ status: 'error', message: apiErrorText(t, error) });
        };
        rdpApi.certificate(server.id, { signal: controller.signal }).then((data) => setCertificate({ status: 'ready', data }), failed);
        rdpApi.options(server.id, { signal: controller.signal }).then((data) => setOptions({ status: 'ready', data }), (error: unknown) => {
            if (controller.signal.aborted) return;
            // Connecting still works: the backend refuses the saved password if it must.
            setOptions((current) => (current.status === 'ready' ? current : { status: 'error', message: apiErrorText(t, error) }));
        });
        return () => controller.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- t only translates the error text
    }, [server.id, isActive, live, certificateRevision]);

    const failure: RdpFailure | null = status?.kind === 'failed' ? status.failure : null;
    useEffect(() => {
        if (!failure) return;
        // The server is set to ask for the password (on another device, since
        // this screen was read): ask for it.
        if (failure.code === 'RDP_PASSWORD_REQUIRED') {
            setOptions((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, askPassword: true } } : current));
            setStatus(null);
            askPassword();
            return;
        }
        // A wrong password typed in the dialog: ask again, saying so.
        if (lastCredentials.kind === 'typed' && (failure.code === 'RDP_WRONG_PASSWORD' || failure.code === 'RDP_LOGON_FAILURE')) {
            askPassword(describeFailure(t, failure, { address, port }).message);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per failure
    }, [failure]);

    // --- the live session ---

    // The remote desktop follows the panel (display control), once it stops resizing.
    const connectedKind = status?.kind;
    useEffect(() => {
        if (connectedKind !== 'connected' || prefs.resolution !== 'auto' || !isActive) return;
        if (stage.width < 200 || stage.height < 200) return;
        const timer = setTimeout(() => connectionRef.current?.resize({ width: stage.width, height: stage.height }), RESIZE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [stage.width, stage.height, connectedKind, prefs.resolution, isActive]);

    // Back on the tab: the keyboard goes to the remote desktop again.
    useEffect(() => {
        if (isActive && connectedKind === 'connected') connectionRef.current?.focus();
    }, [isActive, connectedKind]);

    // The session is over: its element is gone (a removed element does not
    // always report losing the focus) and full screen has nothing to show.
    useEffect(() => {
        if (connectedKind === 'connected' || connectedKind === 'connecting') return;
        setKeyboardCaptured(false);
        if (document.fullscreenElement && document.fullscreenElement === rootRef.current) void document.exitFullscreen().catch(() => undefined);
    }, [connectedKind]);

    // The local clipboard is offered when the remote desktop gets the focus,
    // also when the window comes back from another app.
    useEffect(() => {
        if (connectedKind !== 'connected') return;
        const onWindowFocus = () => {
            if (document.activeElement === connectionRef.current?.focusTarget) connectionRef.current?.syncClipboard();
        };
        window.addEventListener('focus', onWindowFocus);
        return () => window.removeEventListener('focus', onWindowFocus);
    }, [connectedKind]);

    useEffect(() => {
        const onChange = () => {
            const on = document.fullscreenElement !== null && document.fullscreenElement === rootRef.current;
            setFullscreen(on);
            if (!on) keyboardLock()?.unlock?.();
        };
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    const toggleFullscreen = async () => {
        if (document.fullscreenElement) {
            await document.exitFullscreen().catch(() => undefined);
            return;
        }
        try {
            await rootRef.current?.requestFullscreen();
            // Win, Alt+Tab and Escape go to the remote desktop too (hold Escape to leave).
            await keyboardLock()?.lock?.().catch(() => undefined);
            connectionRef.current?.focus();
        } catch {
            // Refused (no user gesture, or the window does not allow it).
        }
    };

    const onStageFocus = (event: React.FocusEvent) => {
        if (event.target !== connectionRef.current?.focusTarget) return;
        setKeyboardCaptured(true);
        connectionRef.current?.syncClipboard();
    };
    const onStageBlur = (event: React.FocusEvent) => {
        if (event.target !== connectionRef.current?.focusTarget) return;
        setKeyboardCaptured(false);
        connectionRef.current?.releaseInputs();
    };
    // Ctrl+Alt+Home gives the keyboard back to the app: to the toolbar.
    const onStageKeyDown = (event: React.KeyboardEvent) => {
        if (!isReleaseShortcut(event.nativeEvent)) return;
        event.preventDefault();
        event.stopPropagation();
        connectionRef.current?.releaseInputs();
        toolbarRef.current?.focus();
    };

    // --- certificates ---

    const trust = async () => {
        const mismatch = failure?.mismatch;
        if (!mismatch) return;
        setTrusting(true);
        const socket = createSocket();
        const result = await new Promise<RdpTrustCertificateResult>((resolve) => {
            socket.timeout(10_000).emit(
                'rdp-trust-certificate',
                { serverId: server.id, expected: mismatch.expected.fingerprint, actual: mismatch.actual.fingerprint },
                (error: Error | null, answer: RdpTrustCertificateResult) => resolve(error ? { ok: false, code: 'RDP_BACKEND_TIMEOUT', error: t('rdp.errors.RDP_BACKEND_TIMEOUT') } : answer)
            );
        });
        socket.disconnect();
        setTrusting(false);
        if (!result.ok) {
            toast.error(t('rdp.mismatch.trustFailed'), failureMessage(t, result.code));
            return;
        }
        setCertificateRevision((revision) => revision + 1);
        reconnect();
    };

    // --- layout ---

    const desktop = connected?.desktop ?? null;
    const scale = desktop && prefs.fit && stage.width > 0 && stage.height > 0
        ? Math.min(1, stage.width / desktop.width, stage.height / desktop.height)
        : 1;

    // After an attempt (not a cancelled one) the button connects the same way again.
    const again = status !== null && status.kind !== 'cancelled';
    const accountLabel = (lastCredentials.kind === 'typed' ? lastCredentials.account : savedAccount) || t('rdp.noUser');

    return (
        <div ref={rootRef} className="relative flex h-full w-full flex-col overflow-hidden bg-ink-900">
            {connected && (
                <RdpToolbar
                    ref={toolbarRef}
                    desktop={connected.desktop}
                    compact={stage.width < 960}
                    narrow={stage.width < 640}
                    via={connected.via}
                    clipboard={connected.clipboard}
                    keyboardCaptured={keyboardCaptured}
                    fit={prefs.fit}
                    fullscreen={fullscreen}
                    onCtrlAltDel={() => {
                        connectionRef.current?.ctrlAltDel();
                        connectionRef.current?.focus();
                    }}
                    onKeys={(codes) => connectionRef.current?.sendKeys(codes)}
                    onSendClipboard={() => {
                        connectionRef.current?.focus();
                        connectionRef.current?.syncClipboard();
                    }}
                    onToggleFit={() => updatePrefs({ fit: !prefs.fit })}
                    onToggleFullscreen={() => void toggleFullscreen()}
                    onDisconnect={disconnect}
                    onLeave={() => connectionRef.current?.focus()}
                />
            )}
            <div
                ref={stageRef}
                role={connected ? 'application' : undefined}
                aria-label={connected ? t('rdp.session.label', { name: server.name }) : undefined}
                data-keyboard-capture={live || undefined}
                onFocus={onStageFocus}
                onBlur={onStageBlur}
                onKeyDown={onStageKeyDown}
                className={cn(
                    'relative flex min-h-0 flex-1 bg-black/30',
                    connected && !prefs.fit ? 'overflow-auto' : 'overflow-hidden',
                    keyboardCaptured && 'shadow-[inset_0_0_0_1px_rgb(var(--c-brand-500)/0.45)]'
                )}
            >
                <div
                    className="m-auto shrink-0"
                    style={desktop ? { width: Math.round(desktop.width * scale), height: Math.round(desktop.height * scale) } : undefined}
                >
                    <div
                        ref={mountRef}
                        style={desktop ? { width: desktop.width, height: desktop.height, transform: scale < 1 ? `scale(${scale})` : undefined, transformOrigin: '0 0' } : undefined}
                    />
                </div>
                {status?.kind === 'connecting' && (
                    <div className="absolute inset-0 flex items-center justify-center bg-ink-900/90 p-6">
                        <div role="status" className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-white/[0.06] bg-ink-850/80 p-6 text-center shadow-panel">
                            <Spinner className="h-6 w-6 text-brand-400" />
                            <div className="space-y-1">
                                <p className="text-sm font-semibold text-zinc-100">{server.name}</p>
                                <p className="text-xs text-zinc-400">
                                    {status.step === 'loading' && t('rdp.connecting.loading')}
                                    {status.step === 'server' && t('rdp.connecting.server', { address })}
                                    {status.step === 'securing' && t('rdp.connecting.securing')}
                                    {status.step === 'signing-in' && t('rdp.connecting.signingIn', { user: status.account || t('rdp.noUser') })}
                                </p>
                                {status.via && (
                                    <p className="text-[11px] text-zinc-500">
                                        <Route className="mr-1 inline h-3 w-3" aria-hidden="true" />{t('rdp.via', { jump: status.via })}
                                    </p>
                                )}
                            </div>
                            <Button size="sm" variant="ghost" onClick={disconnect}>{t('rdp.connecting.cancel')}</Button>
                        </div>
                    </div>
                )}
            </div>

            {!live && (
                <div className="absolute inset-0 overflow-y-auto bg-ink-900">
                    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-5 p-6 md:p-8">
                        <header className="flex items-start gap-3">
                            <span aria-hidden="true" className="mt-0.5 rounded-xl border border-white/5 bg-white/[0.03] p-2.5 text-brand-400">
                                <Monitor className="h-5 w-5" />
                            </span>
                            <div className="min-w-0">
                                <h2 id={headingId} className="text-lg font-semibold text-zinc-100">{t('rdp.title')}</h2>
                                <p className="mt-0.5 text-sm text-zinc-400">{t('rdp.subtitle', { name: server.name })}</p>
                                <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                                    <span className="font-mono text-zinc-300">{t('rdp.target', { address, user: accountLabel })}</span>
                                </p>
                            </div>
                        </header>

                        <Outcome
                            status={status}
                            address={address}
                            port={port}
                            trusting={trusting}
                            onTrust={() => void trust()}
                            onDismiss={() => setStatus(null)}
                        />

                        <section aria-labelledby={headingId} className="rounded-2xl border border-white/[0.06] bg-ink-850/60 p-5 [container-type:inline-size]">
                            <div className="flex flex-wrap items-center gap-3">
                                <Button variant="primary" onClick={again ? reconnect : connect}>
                                    <Plug className="h-4 w-4" aria-hidden="true" />
                                    {t(again ? 'rdp.reconnect' : 'rdp.connect')}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => askPassword()}>
                                    <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
                                    {t('rdp.connectAs')}
                                </Button>
                            </div>
                            <p className="mt-3 flex items-start gap-1.5 text-xs text-zinc-400">
                                <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                {!hasPassword ? t('rdp.noSavedPassword') : t(askEachTime ? 'rdp.passwordAsked' : 'rdp.passwordSaved')}
                            </p>

                            <div className="mt-5 grid gap-4 border-t border-white/5 pt-5 [@container(min-width:34rem)]:grid-cols-2">
                                <div className="space-y-3 [@container(min-width:34rem)]:col-span-2">
                                    <Checkbox
                                        checked={askEachTime || !hasPassword}
                                        disabled={!hasPassword || options.status !== 'ready' || savingOptions}
                                        onChange={(ask) => void setAskEachTime(ask)}
                                        label={t('rdp.options.askPassword')}
                                        description={options.status === 'error' ? t('rdp.options.loadFailed', { reason: options.message }) : t('rdp.options.askPasswordHint')}
                                    />
                                    <Checkbox
                                        checked={prefs.clipboard}
                                        onChange={(clipboard) => updatePrefs({ clipboard })}
                                        label={t('rdp.options.clipboard')}
                                        description={t('rdp.options.clipboardHint')}
                                    />
                                </div>
                                <Field label={t('rdp.options.resolution')} hint={prefs.resolution === 'auto' ? t('rdp.options.resolutionAutoHint') : undefined}>
                                    <Select
                                        value={prefs.resolution}
                                        onChange={(value) => updatePrefs({ resolution: value as RdpPrefs['resolution'] })}
                                        options={RESOLUTIONS.map((value) => ({ value, label: value === 'auto' ? t('rdp.options.resolutionAuto') : value.replace('x', ' × ') }))}
                                    />
                                </Field>
                                <Field label={t('rdp.options.keyboard')} hint={t(prefs.keyboard === 'unicode' ? 'rdp.options.keyboardUnicodeHint' : 'rdp.options.keyboardScancodeHint')}>
                                    <SegmentedControl
                                        value={prefs.keyboard}
                                        onChange={(keyboard) => updatePrefs({ keyboard })}
                                        options={[
                                            { value: 'unicode', label: t('rdp.options.keyboardUnicode') },
                                            { value: 'scancode', label: t('rdp.options.keyboardScancode') }
                                        ]}
                                    />
                                </Field>
                                <div className="[@container(min-width:34rem)]:col-span-2">
                                    <Checkbox
                                        checked={prefs.fit}
                                        onChange={(fit) => updatePrefs({ fit })}
                                        label={t('rdp.options.fit')}
                                        description={t('rdp.options.fitHint')}
                                    />
                                </div>
                            </div>
                        </section>

                        <div className="space-y-5 rounded-2xl border border-white/[0.06] bg-ink-850/40 p-5">
                            {certificate.status === 'ready' ? (
                                <CertificateCard
                                    pinned={certificate.data.pinned}
                                    host={certificate.data.host}
                                    port={certificate.data.port}
                                    onForgotten={() => setCertificateRevision((revision) => revision + 1)}
                                />
                            ) : (
                                <CertificatePending error={certificate.status === 'error' ? certificate.message : null} />
                            )}
                            <div className="border-t border-white/5 pt-5">
                                <NativeLaunch server={server} port={port} />
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <PasswordDialog
                open={prompt !== null}
                serverName={server.name}
                account={prompt?.account ?? ''}
                error={prompt?.error}
                onCancel={() => setPrompt(null)}
                onSubmit={(credentials) => {
                    setPrompt(null);
                    begin({ kind: 'typed', ...credentials });
                }}
            />
        </div>
    );
}

// What happened to the last attempt: an error (with the certificate
// comparison when it changed) or the end of the session.
function Outcome({ status, address, port, trusting, onTrust, onDismiss }: {
    status: RdpStatus | null;
    address: string;
    port: number;
    trusting: boolean;
    onTrust: () => void;
    onDismiss: () => void;
}) {
    const t = useT();
    if (status?.kind === 'cancelled') {
        return (
            <div role="status" className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                <p className="text-sm font-medium text-zinc-200">{t('rdp.cancelled.title')}</p>
                <p className="mt-0.5 text-xs text-zinc-400">{t('rdp.cancelled.message')}</p>
            </div>
        );
    }
    if (status?.kind === 'ended') {
        // The server's reason, translated when ShellMind knows it.
        const reason = status.byUser ? { text: null, raw: null } : describeEndReason(t, status.reason);
        return (
            <div role="status" className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                <p className="text-sm font-medium text-zinc-200">{t('rdp.ended.title')}</p>
                <p className="mt-0.5 text-xs text-zinc-400">{reason.text ?? t(status.byUser ? 'rdp.ended.byUser' : 'rdp.ended.byServer')}</p>
                {reason.raw && <p className="mt-1.5 break-words font-mono text-[11px] leading-relaxed text-zinc-500">{t('rdp.ended.reason', { reason: reason.raw })}</p>}
            </div>
        );
    }
    if (status?.kind !== 'failed') return null;
    const { failure } = status;
    if (failure.code === 'RDP_CERT_MISMATCH' && failure.mismatch) {
        return <CertificateMismatch expected={failure.mismatch.expected} actual={failure.mismatch.actual} trusting={trusting} onTrust={onTrust} onCancel={onDismiss} />;
    }
    const text = describeFailure(t, failure, { address, port });
    return (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/[0.07] px-4 py-3">
            <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" />
                <div className="min-w-0 space-y-1.5">
                    <p className="text-sm font-semibold text-rose-100">{text.title}</p>
                    <p className="text-xs leading-relaxed text-zinc-300">{text.message}</p>
                    {text.tips.length > 0 && (
                        <ul className="list-inside list-disc space-y-0.5 text-xs text-zinc-400">
                            {text.tips.map((tip) => <li key={tip}>{tip}</li>)}
                        </ul>
                    )}
                    {text.technical && (
                        <p className="pt-0.5">
                            <Badge tone="neutral" className="font-mono" title={text.technical}>{text.technical}</Badge>
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
