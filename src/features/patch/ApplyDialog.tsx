import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, MinusCircle, PackageCheck, Play, RotateCw, ShieldCheck } from 'lucide-react';
import { minPatchTimeoutSec, PATCH_LIMITS, type PatchApplyResponse, type PatchMode, type PatchPreview, type PatchPreviewServer } from '@shared/patch';
import { Button, Checkbox, Field, Input, Modal, SegmentedControl, Select, Spinner, useToast } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/relativeTime';
import { DEFAULT_STRATEGY_FORM, StrategyFields, strategyFromForm, type StrategyForm } from '@/features/multiexec/public';
import { patchApi } from './api';
import { Dash, ErrorBox, managerName, SecurityCount } from './bits';
import { usePatchStore } from './store';

// Starting a patch run: what to do (security updates, all of them, or only
// refreshing the package lists), whether to refresh first and to reboot the
// servers that need it, how to roll out (multi-exec's batches, canary and
// failure limit), then the backend's preview: who runs and who does not and
// why, the commands per package manager and the script itself. A fleet run
// is confirmed by typing the number of servers it starts on.

type ApplyDialogProps = {
    serverIds: number[];
    // Names for the title of a one-server run.
    names: ReadonlyMap<number, string>;
    initialMode?: PatchMode;
    onClose: () => void;
    onStarted: (response: PatchApplyResponse) => void;
};

const REBOOT_WAITS = [5, 10, 15, 30];
const TIMEOUTS = [15, 30, 60];

function canaryDefault(count: number): StrategyForm {
    // Patching a fleet starts with one server and waits for approval.
    return count >= 3 ? { ...DEFAULT_STRATEGY_FORM, canary: true, canaryCount: '1', canaryThen: 'pause' } : DEFAULT_STRATEGY_FORM;
}

function ServerRow({ entry, now }: { entry: PatchPreviewServer; now: number }) {
    const t = useT();
    const language = useLanguage();
    const runs = entry.skip === null;
    return (
        <tr className="border-t border-white/5 align-top">
            <td className="py-1.5 pr-3">
                <span className="flex items-center gap-1.5">
                    {runs
                        ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden="true" />
                        : <MinusCircle className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />}
                    <span className={cn('truncate', runs ? 'text-zinc-100' : 'text-zinc-400')}>{entry.name}</span>
                    <span className="sr-only">{runs ? t('patch.preview.willRun') : t('patch.preview.skipped')}</span>
                </span>
                {entry.scannedAt !== null && <span className="ml-5 block text-[11px] text-zinc-500">{t('patch.preview.scanned', { when: formatRelativeTime(entry.scannedAt, now, language) })}</span>}
            </td>
            <td className="py-1.5 pr-3 text-zinc-300">{entry.manager ? managerName(t, entry.manager) : <Dash label={t('patch.values.unknown')} />}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums text-zinc-200">{entry.pending ?? <Dash label={t('patch.values.unknown')} />}</td>
            <td className="py-1.5 pr-3 text-right"><SecurityCount value={entry.manager ? entry.security : null} manager={entry.manager} /></td>
            <td className="py-1.5 text-zinc-300">
                {runs
                    ? <span className={cn(entry.reboot === 'if-required' && entry.rebootRequired && 'text-amber-300')}>{t(`patch.preview.rebootPlan.${entry.reboot}`)}</span>
                    : <span className="text-zinc-400">{t(`patch.skip.${entry.skip}`)}</span>}
            </td>
        </tr>
    );
}

export function ApplyDialog({ serverIds: requested, names, initialMode = 'security', onClose, onStarted }: ApplyDialogProps) {
    const t = useT();
    const toast = useToast();
    const id = useId();
    // The servers of this run, as the dialog opened with them.
    const [serverIds] = useState(requested);
    const single = serverIds.length === 1;
    const name = names.get(serverIds[0]) ?? `#${serverIds[0]}`;
    const [step, setStep] = useState<'options' | 'review'>('options');
    const [mode, setMode] = useState<PatchMode>(initialMode);
    const [refresh, setRefresh] = useState(false);
    const [reboot, setReboot] = useState(false);
    const [rebootWait, setRebootWait] = useState(String(PATCH_LIMITS.defaultRebootWaitSec / 60));
    const [timeout, setTimeoutMinutes] = useState(String(PATCH_LIMITS.defaultTimeoutSec / 60));
    const [form, setForm] = useState<StrategyForm>(() => canaryDefault(serverIds.length));
    const [preview, setPreview] = useState<PatchPreview | null>(null);
    const [previewError, setPreviewError] = useState<unknown>(null);
    const [typed, setTyped] = useState('');
    const [starting, setStarting] = useState(false);
    const [startError, setStartError] = useState<unknown>(null);
    const [showProblems, setShowProblems] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    const now = Date.now();

    const refreshOnly = mode === 'refresh';
    // With a reboot, the time per server has room for the wait for SSH: a
    // shorter choice gives way to the shortest one that does.
    const minTimeout = Math.ceil(minPatchTimeoutSec({ reboot: !refreshOnly && reboot }, Number(rebootWait) * 60) / 60);
    const timeoutMinutes = Number(timeout) >= minTimeout ? timeout : String(TIMEOUTS.find((minutes) => minutes >= minTimeout) ?? TIMEOUTS[TIMEOUTS.length - 1]);
    const optionsCheck = strategyFromForm(form, serverIds.length, t);
    const eligible = preview?.eligible ?? 0;
    const reviewCheck = useMemo(() => strategyFromForm(form, Math.max(eligible, 1), t), [form, eligible, t]);
    const confirmed = single || eligible <= 1 || typed.trim() === String(eligible);

    // The preview for the options chosen.
    useEffect(() => {
        if (step !== 'review') return;
        const controller = new AbortController();
        setPreview(null);
        setPreviewError(null);
        patchApi.preview({ serverIds, mode, refresh: refreshOnly || refresh, reboot: !refreshOnly && reboot }, controller.signal)
            .then((result) => {
                if (!controller.signal.aborted) setPreview(result);
            }, (error: unknown) => {
                if (!controller.signal.aborted) setPreviewError(error);
            });
        return () => controller.abort();
    }, [step, serverIds, mode, refresh, reboot, refreshOnly]);

    // Focus goes to the top of the step that shows.
    useEffect(() => {
        bodyRef.current?.querySelector<HTMLElement>('[data-step-focus]')?.focus({ preventScroll: true });
    }, [step, preview]);

    const review = () => {
        setShowProblems(true);
        if (!single && !optionsCheck.strategy) return;
        setTyped('');
        setStartError(null);
        setStep('review');
    };

    const start = async () => {
        if (!preview || !confirmed || starting) return;
        const strategy = single ? null : reviewCheck.strategy;
        if (!single && !strategy) return;
        setStarting(true);
        setStartError(null);
        try {
            const response = await usePatchStore.getState().startRun({
                serverIds,
                mode,
                refresh: refreshOnly || refresh,
                reboot: !refreshOnly && reboot,
                strategy,
                timeoutSec: Number(timeoutMinutes) * 60,
                rebootWaitSec: Number(rebootWait) * 60,
                confirm: preview.eligible
            });
            toast.success(
                t('patch.toasts.started'),
                response.targets.length === 1 ? t('patch.toasts.startedTextOne', { name: response.targets[0].name }) : t('patch.toasts.startedText', { count: response.targets.length })
            );
            onStarted(response);
        } catch (error) {
            setStartError(error);
        } finally {
            setStarting(false);
        }
    };

    const rebootingNow = preview?.servers.filter((entry) => entry.skip === null && entry.reboot === 'if-required' && entry.rebootRequired) ?? [];
    const runs = preview?.servers.filter((entry) => entry.skip === null) ?? [];
    const skipped = preview?.servers.filter((entry) => entry.skip !== null) ?? [];
    const action = t(`patch.preview.actions.${mode}`);
    const danger = !refreshOnly && reboot;

    const footer = step === 'options' ? (
        <Fragment key="options">
            <Button variant="ghost" size="sm" onClick={onClose} className="ml-auto">{t('patch.apply.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={review}>{t('patch.apply.review')}</Button>
        </Fragment>
    ) : (
        <Fragment key="review">
            <Button variant="ghost" size="sm" onClick={() => setStep('options')} className="mr-auto">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />{t('patch.apply.back')}
            </Button>
            <Button
                variant={danger ? 'danger' : 'primary'}
                size="sm"
                onClick={() => void start()}
                disabled={!preview || eligible === 0 || !confirmed || (!single && !reviewCheck.strategy)}
                loading={starting}
            >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                {eligible === 1 ? t('patch.apply.startOne', { name: runs[0]?.name ?? name }) : t('patch.apply.start', { count: eligible })}
            </Button>
        </Fragment>
    );

    return (
        <Modal
            open
            onClose={onClose}
            title={single ? t('patch.apply.titleOne', { name }) : t('patch.apply.title', { count: serverIds.length })}
            icon={<PackageCheck className="h-4 w-4" />}
            widthClass="max-w-3xl"
            footer={footer}
        >
            <div ref={bodyRef} className="space-y-4">
                {step === 'options' ? (
                    <>
                        <Field label={t('patch.apply.mode')} group id={`${id}-mode`}>
                            <SegmentedControl
                                variant="cards"
                                value={mode}
                                onChange={setMode}
                                options={[
                                    { value: 'security', label: t('patch.apply.modes.security'), hint: t('patch.apply.modes.securityHint'), icon: <ShieldCheck className="h-4 w-4" /> },
                                    { value: 'all', label: t('patch.apply.modes.all'), hint: t('patch.apply.modes.allHint'), icon: <PackageCheck className="h-4 w-4" /> },
                                    { value: 'refresh', label: t('patch.apply.modes.refresh'), hint: t('patch.apply.modes.refreshHint'), icon: <RotateCw className="h-4 w-4" /> }
                                ]}
                            />
                        </Field>
                        <p className="-mt-2 text-xs text-zinc-400" data-step-focus tabIndex={-1}>
                            {t(`patch.apply.modes.${mode}Hint`)}
                        </p>
                        {!refreshOnly && (
                            <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                                <Checkbox checked={refresh} onChange={setRefresh} label={t('patch.apply.refreshFirst')} description={t('patch.apply.refreshFirstHint')} />
                                <Checkbox checked={reboot} onChange={setReboot} label={t('patch.apply.reboot')} description={t('patch.apply.rebootHint')} />
                                {reboot && (
                                    <div className="ml-6 w-48">
                                        <Field label={t('patch.apply.rebootWait')}>
                                            <Select
                                                value={rebootWait}
                                                onChange={setRebootWait}
                                                options={REBOOT_WAITS.map((minutes) => ({ value: String(minutes), label: t('patch.apply.minutes', { count: minutes }) }))}
                                                className="h-8 text-xs"
                                            />
                                        </Field>
                                    </div>
                                )}
                            </div>
                        )}
                        <div className="max-w-sm">
                            <Field label={t('patch.apply.timeout')} hint={!refreshOnly && reboot ? t('patch.apply.timeoutHintReboot', { count: minTimeout }) : t('patch.apply.timeoutHint')}>
                                <Select
                                    value={timeoutMinutes}
                                    onChange={setTimeoutMinutes}
                                    options={TIMEOUTS.map((minutes) => ({ value: String(minutes), label: t('patch.apply.minutes', { count: minutes }), disabled: minutes < minTimeout }))}
                                    className="h-8 w-48 text-xs"
                                />
                            </Field>
                        </div>
                        {!single && <StrategyFields form={form} onChange={setForm} check={optionsCheck} targets={serverIds.length} showProblems={showProblems} />}
                    </>
                ) : !preview ? (
                    previewError
                        ? <ErrorBox error={previewError} heading={t('patch.errors.previewFailed')} />
                        : <div className="flex items-center gap-2 py-8 text-sm text-zinc-400" role="status"><Spinner className="h-4 w-4" />{t('patch.preview.loading')}</div>
                ) : (
                    <>
                        <section aria-labelledby={`${id}-heading`} className="space-y-1.5">
                            <h3 id={`${id}-heading`} tabIndex={-1} data-step-focus className="rounded text-sm font-semibold text-zinc-100 focus-ring">{t('patch.preview.heading')}</h3>
                            {eligible === 0 ? (
                                <p className="text-sm text-amber-200" role="alert">{t('patch.preview.nothing')}</p>
                            ) : (
                                <>
                                    <p className="text-sm text-zinc-200">
                                        {eligible === 1 && single
                                            ? t('patch.preview.summaryOne', { action, name: runs[0]?.name ?? name })
                                            : t('patch.preview.summary', { action, count: eligible, total: preview.servers.length })}
                                    </p>
                                    {!refreshOnly && <p className="text-xs text-zinc-400">{t('patch.preview.totals', { pending: preview.totals.pending, security: preview.totals.security })}</p>}
                                    {preview.options.refresh && !refreshOnly && <p className="text-xs text-zinc-400">{t('patch.preview.refreshFirst')}</p>}
                                    {preview.options.reboot && (
                                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-100">
                                            <p className="flex items-center gap-1.5 font-medium"><RotateCw className="h-3.5 w-3.5" aria-hidden="true" />{t('patch.preview.reboots')}</p>
                                            {rebootingNow.length > 0 && <p className="mt-1 text-amber-200/90">{t('patch.preview.rebootNow', { names: rebootingNow.map((entry) => entry.name).join(', ') })}</p>}
                                        </div>
                                    )}
                                </>
                            )}
                        </section>

                        <div className="max-h-64 overflow-auto rounded-xl border border-white/5 px-3 scrollbar-thin">
                            <table className="w-full table-fixed text-left text-xs">
                                <caption className="sr-only">{t('patch.preview.servers')}</caption>
                                <thead className="text-[11px] uppercase tracking-wider text-zinc-400">
                                    <tr>
                                        <th scope="col" className="w-[38%] py-2 pr-3 font-medium">{t('patch.columns.server')}</th>
                                        <th scope="col" className="w-[16%] py-2 pr-3 font-medium">{t('patch.columns.manager')}</th>
                                        <th scope="col" className="w-[11%] py-2 pr-3 text-right font-medium">{t('patch.preview.toInstall')}</th>
                                        <th scope="col" className="w-[11%] py-2 pr-3 text-right font-medium">{t('patch.columns.security')}</th>
                                        <th scope="col" className="py-2 font-medium"><span className="sr-only">{t('patch.columns.status')}</span></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...runs, ...skipped].map((entry) => <ServerRow key={entry.serverId} entry={entry} now={now} />)}
                                </tbody>
                            </table>
                        </div>

                        {preview.commands.length > 0 && (
                            <section className="space-y-1.5" aria-labelledby={`${id}-commands`}>
                                <h4 id={`${id}-commands`} className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('patch.preview.commands')}</h4>
                                <p className="text-xs text-zinc-400">{t('patch.preview.commandsHint')}</p>
                                <div className="space-y-2">
                                    {preview.commands.map((plan) => (
                                        <div key={plan.manager} className="rounded-lg border border-white/5 bg-black/30 px-3 py-2">
                                            <p className="mb-1 text-[11px] font-semibold text-zinc-300">{managerName(t, plan.manager)}</p>
                                            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-200">{plan.commands.join('\n')}</pre>
                                        </div>
                                    ))}
                                </div>
                                <details className="rounded-lg border border-white/5">
                                    <summary className="cursor-pointer rounded-lg px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.03] focus-ring">{t('patch.preview.script')}</summary>
                                    <pre className="max-h-64 overflow-auto border-t border-white/5 px-3 py-2 font-mono text-[11px] text-zinc-300 scrollbar-thin">{preview.script}</pre>
                                </details>
                            </section>
                        )}

                        {!single && eligible > 0 && (
                            <>
                                {!reviewCheck.strategy && <p role="alert" className="text-xs text-rose-200">{reviewCheck.problems.join(' ')}</p>}
                                {eligible > 1 ? (
                                    <div className="space-y-1.5 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                                        <label htmlFor={`${id}-typed`} className="block text-xs font-medium text-zinc-100">{t('patch.preview.confirmLabel', { count: eligible })}</label>
                                        <Input
                                            id={`${id}-typed`}
                                            value={typed}
                                            onChange={(event) => setTyped(event.target.value)}
                                            inputMode="numeric"
                                            autoComplete="off"
                                            aria-describedby={`${id}-typed-hint`}
                                            className="h-8 w-28 text-sm"
                                        />
                                        <p id={`${id}-typed-hint`} className="text-xs text-zinc-400">{t('patch.preview.confirmHint')}</p>
                                    </div>
                                ) : <p className="text-xs text-zinc-400">{t('patch.preview.oneConfirm')}</p>}
                            </>
                        )}
                        {single && eligible > 0 && <p className="text-xs text-zinc-400">{t('patch.preview.oneConfirm')}</p>}
                        {startError !== null && <ErrorBox error={startError} heading={t('patch.errors.startFailed')} />}
                    </>
                )}
            </div>
        </Modal>
    );
}
