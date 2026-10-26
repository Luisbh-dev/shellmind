import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Cable } from 'lucide-react';
import {
    DEFAULT_BIND_HOST,
    DEFAULT_REMOTE_HOST,
    formatHostPort,
    isLoopbackHost,
    isValidBindHost,
    isValidPort,
    isValidRemoteHost,
    MAX_TUNNEL_NAME_LENGTH,
    presetForPort,
    suggestedLocalPort,
    TUNNEL_PRESETS,
    tunnelConnectAddress,
    type TunnelInput,
    type TunnelPresetId,
    type TunnelView
} from '@shared/tunnels';
import { Button, Input, Modal } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { problemFromError, type TunnelProblem } from './format';

export interface TunnelFormProps {
    serverName: string;
    // Edited tunnel; a new one is created otherwise.
    tunnel?: TunnelView;
    initialPreset?: TunnelPresetId;
    onClose: () => void;
    // Saves (and starts when `start`); rejects to keep the form open.
    onSubmit: (input: TunnelInput, start: boolean) => Promise<void>;
}

const parsePort = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value) : NaN);

type FieldProps = {
    id: string;
    label: string;
    hint?: string;
    error?: string | false;
    className?: string;
    children: (describedBy: string | undefined) => React.ReactNode;
};

function FormField({ id, label, hint, error, className, children }: FieldProps) {
    const hintId = hint ? `${id}-hint` : undefined;
    const errorId = error ? `${id}-error` : undefined;
    const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
    return (
        <div className={cn('space-y-1.5', className)}>
            <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">{label}</label>
            {children(describedBy)}
            {error && <p id={errorId} className="text-xs text-rose-300">{error}</p>}
            {hint && <p id={hintId} className="text-xs text-zinc-500">{hint}</p>}
        </div>
    );
}

export function TunnelForm({ serverName, tunnel, initialPreset = 'custom', onClose, onSubmit }: TunnelFormProps) {
    const t = useT();
    const id = useId();
    const nameRef = useRef<HTMLInputElement>(null);
    const startPreset = tunnel ? presetForPort(tunnel.remote_port)?.id ?? 'custom' : initialPreset;
    const startPort = TUNNEL_PRESETS.find((preset) => preset.id === startPreset)?.remotePort ?? null;

    const [preset, setPreset] = useState<TunnelPresetId>(startPreset);
    const [name, setName] = useState(tunnel?.name ?? '');
    const [localHost, setLocalHost] = useState(tunnel?.local_host ?? DEFAULT_BIND_HOST);
    const [localPort, setLocalPort] = useState(String(tunnel?.local_port ?? (startPort ? suggestedLocalPort(startPort) : '')));
    const [remoteHost, setRemoteHost] = useState(tunnel?.remote_host ?? DEFAULT_REMOTE_HOST);
    const [remotePort, setRemotePort] = useState(String(tunnel?.remote_port ?? startPort ?? ''));
    const [autoStart, setAutoStart] = useState(tunnel?.auto_start ?? false);
    const [exposureConfirmed, setExposureConfirmed] = useState(false);
    const [showErrors, setShowErrors] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [failure, setFailure] = useState<TunnelProblem | null>(null);

    useEffect(() => {
        nameRef.current?.focus();
    }, []);

    const running = tunnel ? tunnel.status.state === 'listening' || tunnel.status.state === 'starting' : false;
    const bindHost = localHost.trim() || DEFAULT_BIND_HOST;
    const validBindHost = isValidBindHost(bindHost);
    const exposed = validBindHost && !isLoopbackHost(bindHost);
    const needsConfirmation = exposed && bindHost !== tunnel?.local_host;
    const localPortValue = parsePort(localPort);
    const remotePortValue = parsePort(remotePort);
    const remoteHostValue = remoteHost.trim() || DEFAULT_REMOTE_HOST;
    const remote = isValidPort(remotePortValue) ? formatHostPort(remoteHostValue, remotePortValue) : remoteHostValue;

    const errors = {
        localHost: !validBindHost && t('tunnels.form.invalidLocalHost'),
        localPort: !isValidPort(localPortValue) && t('tunnels.form.invalidPort'),
        remoteHost: !isValidRemoteHost(remoteHostValue) && t('tunnels.form.invalidRemoteHost'),
        remotePort: !isValidPort(remotePortValue) && t('tunnels.form.invalidPort')
    };
    const invalid = Object.values(errors).some(Boolean);
    const shown = (error: string | false) => showErrors && error;

    const choosePreset = (next: TunnelPresetId) => {
        setPreset(next);
        const port = TUNNEL_PRESETS.find((candidate) => candidate.id === next)?.remotePort;
        if (!port) return;
        setRemotePort(String(port));
        setLocalPort(String(suggestedLocalPort(port)));
    };

    const submit = async (start: boolean) => {
        setShowErrors(true);
        if (invalid || (needsConfirmation && !exposureConfirmed)) return;
        const endpoints = {
            name: name.trim() || null,
            local_host: bindHost,
            local_port: localPortValue,
            remote_host: remoteHost.trim() || DEFAULT_REMOTE_HOST,
            remote_port: remotePortValue
        };
        const input: TunnelInput = { ...endpoints, auto_start: autoStart, ...(needsConfirmation ? { confirm_public_bind: true } : {}) };
        setSubmitting(true);
        setFailure(null);
        try {
            await onSubmit(input, start);
        } catch (err) {
            setFailure(problemFromError(t, err, endpoints));
            setSubmitting(false);
        }
    };

    const offerStart = !running;
    const formId = `${id}-form`;
    const presetName = (presetId: TunnelPresetId) =>
        presetId === 'custom' ? t('tunnels.presets.custom') : TUNNEL_PRESETS.find((candidate) => candidate.id === presetId)?.name ?? presetId;

    return (
        <Modal
            open
            onClose={onClose}
            dismissible={!submitting}
            widthClass="max-w-xl"
            icon={<Cable className="h-4 w-4" />}
            title={tunnel ? t('tunnels.form.editTitle') : t('tunnels.form.createTitle')}
            description={t('tunnels.form.description', { server: serverName })}
            footer={
                <>
                    <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={submitting}>{t('common.cancel')}</Button>
                    {offerStart ? (
                        <>
                            <Button type="button" size="sm" onClick={() => void submit(false)} disabled={submitting}>{t('tunnels.form.save')}</Button>
                            <Button variant="primary" size="sm" type="submit" form={formId} loading={submitting}>{t('tunnels.form.saveAndStart')}</Button>
                        </>
                    ) : (
                        <Button variant="primary" size="sm" type="submit" form={formId} loading={submitting}>{t('tunnels.form.save')}</Button>
                    )}
                </>
            }
        >
            <form
                id={formId}
                noValidate
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit(offerStart);
                }}
            >
                <fieldset>
                    <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('tunnels.form.service')}</legend>
                    <div className="flex flex-wrap gap-1.5">
                        {TUNNEL_PRESETS.map((candidate) => (
                            <button
                                key={candidate.id}
                                type="button"
                                aria-pressed={preset === candidate.id}
                                onClick={() => choosePreset(candidate.id)}
                                className={cn(
                                    'rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors focus-ring',
                                    preset === candidate.id
                                        ? 'border-brand-500/50 bg-brand-500/15 text-brand-200'
                                        : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.07]'
                                )}
                            >
                                {presetName(candidate.id)}
                                {candidate.remotePort && <>{' '}<span className="ml-1 font-mono text-[10px] text-zinc-500">{candidate.remotePort}</span></>}
                            </button>
                        ))}
                    </div>
                </fieldset>

                <FormField id={`${id}-name`} label={t('tunnels.form.name')}>
                    {(describedBy) => (
                        <Input
                            ref={nameRef}
                            id={`${id}-name`}
                            value={name}
                            maxLength={MAX_TUNNEL_NAME_LENGTH}
                            placeholder={preset === 'custom' ? t('tunnels.form.namePlaceholder') : presetName(preset)}
                            aria-describedby={describedBy}
                            onChange={(event) => setName(event.target.value)}
                        />
                    )}
                </FormField>

                <div className="grid gap-4 sm:grid-cols-2">
                    <fieldset className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                        <legend className="px-1 text-[11px] font-semibold text-zinc-300">{t('tunnels.form.localSection')}</legend>
                        <FormField id={`${id}-local-host`} label={t('tunnels.form.localHost')} hint={t('tunnels.form.localHostHint')} error={shown(errors.localHost)}>
                            {(describedBy) => (
                                <Input
                                    id={`${id}-local-host`}
                                    value={localHost}
                                    spellCheck={false}
                                    className="font-mono"
                                    aria-invalid={Boolean(shown(errors.localHost))}
                                    aria-describedby={describedBy}
                                    onChange={(event) => {
                                        setLocalHost(event.target.value);
                                        setExposureConfirmed(false);
                                    }}
                                />
                            )}
                        </FormField>
                        <FormField
                            id={`${id}-local-port`}
                            label={t('tunnels.form.localPort')}
                            hint={isValidPort(localPortValue) && validBindHost
                                ? t('tunnels.form.localPortHint', { address: tunnelConnectAddress({ local_host: bindHost, local_port: localPortValue }) })
                                : undefined}
                            error={shown(errors.localPort)}
                        >
                            {(describedBy) => (
                                <Input
                                    id={`${id}-local-port`}
                                    value={localPort}
                                    inputMode="numeric"
                                    className="font-mono"
                                    aria-invalid={Boolean(shown(errors.localPort))}
                                    aria-describedby={describedBy}
                                    onChange={(event) => setLocalPort(event.target.value)}
                                />
                            )}
                        </FormField>
                    </fieldset>

                    <fieldset className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                        <legend className="px-1 text-[11px] font-semibold text-zinc-300">{t('tunnels.form.remoteSection', { server: serverName })}</legend>
                        <FormField id={`${id}-remote-host`} label={t('tunnels.form.remoteHost')} hint={t('tunnels.form.remoteHostHint')} error={shown(errors.remoteHost)}>
                            {(describedBy) => (
                                <Input
                                    id={`${id}-remote-host`}
                                    value={remoteHost}
                                    spellCheck={false}
                                    className="font-mono"
                                    aria-invalid={Boolean(shown(errors.remoteHost))}
                                    aria-describedby={describedBy}
                                    onChange={(event) => setRemoteHost(event.target.value)}
                                />
                            )}
                        </FormField>
                        <FormField id={`${id}-remote-port`} label={t('tunnels.form.remotePort')} error={shown(errors.remotePort)}>
                            {(describedBy) => (
                                <Input
                                    id={`${id}-remote-port`}
                                    value={remotePort}
                                    inputMode="numeric"
                                    className="font-mono"
                                    aria-invalid={Boolean(shown(errors.remotePort))}
                                    aria-describedby={describedBy}
                                    onChange={(event) => {
                                        setRemotePort(event.target.value);
                                        setPreset(presetForPort(parsePort(event.target.value))?.id ?? 'custom');
                                    }}
                                />
                            )}
                        </FormField>
                    </fieldset>
                </div>

                {exposed && (
                    <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3 text-xs text-amber-100">
                        <p className="flex items-center gap-2 font-semibold text-amber-300">
                            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                            {t('tunnels.form.exposedTitle')}
                        </p>
                        <p className="leading-relaxed text-amber-100/80">{t('tunnels.form.exposedBody', { host: bindHost, remote })}</p>
                        {needsConfirmation && (
                            <label className="flex items-center gap-2 font-medium">
                                <input
                                    type="checkbox"
                                    checked={exposureConfirmed}
                                    onChange={(event) => setExposureConfirmed(event.target.checked)}
                                    className="h-4 w-4 accent-amber-500"
                                />
                                {t('tunnels.form.exposedConfirm', { host: bindHost })}
                            </label>
                        )}
                    </div>
                )}

                <label className="flex items-center gap-2 text-sm text-zinc-300">
                    <input
                        type="checkbox"
                        checked={autoStart}
                        onChange={(event) => setAutoStart(event.target.checked)}
                        className="h-4 w-4 accent-brand-500"
                    />
                    {t('tunnels.form.autoStart')}
                </label>

                {running && <p className="text-xs text-zinc-400">{t('tunnels.form.restartHint')}</p>}

                {showErrors && needsConfirmation && !exposureConfirmed && !invalid && (
                    <p role="alert" className="text-xs text-amber-300">{t('tunnels.form.exposedRequired', { host: bindHost })}</p>
                )}

                {failure && (
                    <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                        <p className="font-medium">{t('tunnels.form.saveFailed')}</p>
                        <p className="mt-0.5">{failure.text}</p>
                        {failure.detail && <p className="mt-0.5 text-rose-200/70">{failure.detail}</p>}
                    </div>
                )}
            </form>
        </Modal>
    );
}
