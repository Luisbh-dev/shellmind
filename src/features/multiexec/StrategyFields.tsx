import { useId } from 'react';
import { Layers, Zap } from 'lucide-react';
import { MULTIEXEC_LIMITS, planBatches } from '@shared/multiexec';
import { Checkbox, Input, SegmentedControl, Select } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { FieldGroup, FormField } from '@/features/snippets/public';
import { BatchStrip } from './BatchStrip';
import { describePlan, type StrategyCheck, type StrategyForm } from './strategy';

interface StrategyFieldsProps {
    form: StrategyForm;
    onChange: (form: StrategyForm) => void;
    check: StrategyCheck;
    // Servers selected.
    targets: number;
    showProblems: boolean;
}

const NUMBER_INPUT = 'h-8 py-1 text-xs';

// How the job rolls out: all at once or in batches, an optional canary first,
// and a failure limit.
export function StrategyFields({ form, onChange, check, targets, showProblems }: StrategyFieldsProps) {
    const t = useT();
    const id = useId();
    const set = <K extends keyof StrategyForm>(key: K, value: StrategyForm[K]) => onChange({ ...form, [key]: value });
    const invalid = (key: keyof StrategyForm) => (showProblems && check.invalid.has(key)) || undefined;
    const plan = check.strategy && targets > 0 ? describePlan(check.strategy, targets, t) : [];
    const sizes = check.strategy && targets > 0 ? planBatches(targets, check.strategy) : [];

    return (
        <fieldset className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('multiexec.strategy.title')}</legend>

            <SegmentedControl
                aria-label={t('multiexec.strategy.mode')}
                value={form.mode}
                onChange={(mode) => set('mode', mode)}
                options={[
                    { value: 'parallel', label: t('multiexec.strategy.parallel'), icon: <Zap className="h-3.5 w-3.5" />, hint: t('multiexec.strategy.parallelHint') },
                    { value: 'rolling', label: t('multiexec.strategy.rolling'), icon: <Layers className="h-3.5 w-3.5" />, hint: t('multiexec.strategy.rollingHint') }
                ]}
            />

            <div className={cn('grid gap-3', form.mode === 'rolling' ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2')}>
                {form.mode === 'rolling' && (
                    <>
                        <FieldGroup labelId={`${id}-batch`} label={t('multiexec.strategy.batchSize')}>
                            <div className="flex gap-1.5">
                                <Input
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    max={form.batchUnit === 'percent' ? 100 : MULTIEXEC_LIMITS.maxTargets}
                                    value={form.batchSize}
                                    onChange={(event) => set('batchSize', event.target.value)}
                                    aria-label={t('multiexec.strategy.batchSize')}
                                    aria-invalid={invalid('batchSize')}
                                    className={cn(NUMBER_INPUT, 'w-20')}
                                />
                                <Select
                                    value={form.batchUnit}
                                    onChange={(unit) => set('batchUnit', unit === 'servers' ? 'servers' : 'percent')}
                                    aria-label={t('multiexec.strategy.batchUnit')}
                                    className={cn(NUMBER_INPUT, 'min-w-0 flex-1')}
                                    options={[
                                        { value: 'percent', label: t('multiexec.strategy.unitPercent') },
                                        { value: 'servers', label: t('multiexec.strategy.unitServers') }
                                    ]}
                                />
                            </div>
                        </FieldGroup>
                        <FormField id={`${id}-pause`} label={t('multiexec.strategy.pause')}>
                            <Input
                                id={`${id}-pause`}
                                type="number"
                                inputMode="numeric"
                                min={0}
                                max={MULTIEXEC_LIMITS.maxPauseSec}
                                value={form.pauseSec}
                                onChange={(event) => set('pauseSec', event.target.value)}
                                aria-invalid={invalid('pauseSec')}
                                className={NUMBER_INPUT}
                            />
                        </FormField>
                    </>
                )}
                <FormField id={`${id}-concurrency`} label={t('multiexec.compose.concurrency')} hint={form.mode === 'parallel' ? t('multiexec.compose.concurrencyHint') : undefined} hintId={`${id}-concurrency-hint`}>
                    <Input
                        id={`${id}-concurrency`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={MULTIEXEC_LIMITS.maxConcurrency}
                        value={form.concurrency}
                        onChange={(event) => set('concurrency', event.target.value)}
                        aria-invalid={invalid('concurrency')}
                        aria-describedby={form.mode === 'parallel' ? `${id}-concurrency-hint` : undefined}
                        className={NUMBER_INPUT}
                    />
                </FormField>
            </div>

            <div className="space-y-2">
                <Checkbox
                    checked={form.canary}
                    onChange={(checked) => set('canary', checked)}
                    label={t('multiexec.strategy.canary')}
                    description={t('multiexec.strategy.canaryHint')}
                />
                {form.canary && (
                    <div className="ml-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <FormField id={`${id}-canary`} label={t('multiexec.strategy.canaryCount')}>
                            <Input
                                id={`${id}-canary`}
                                type="number"
                                inputMode="numeric"
                                min={1}
                                value={form.canaryCount}
                                onChange={(event) => set('canaryCount', event.target.value)}
                                aria-invalid={invalid('canaryCount')}
                                className={NUMBER_INPUT}
                            />
                        </FormField>
                        <FieldGroup labelId={`${id}-canary-then`} label={t('multiexec.strategy.canaryThen')}>
                            <Select
                                value={form.canaryThen}
                                onChange={(value) => set('canaryThen', value === 'continue' ? 'continue' : 'pause')}
                                className={NUMBER_INPUT}
                                options={[
                                    { value: 'pause', label: t('multiexec.strategy.thenPause'), description: t('multiexec.strategy.thenPauseHint') },
                                    { value: 'continue', label: t('multiexec.strategy.thenContinue'), description: t('multiexec.strategy.thenContinueHint') }
                                ]}
                            />
                        </FieldGroup>
                    </div>
                )}
            </div>

            <div className="space-y-2">
                <Checkbox
                    checked={form.failureLimit}
                    onChange={(checked) => set('failureLimit', checked)}
                    label={t('multiexec.strategy.failureLimit')}
                    description={t('multiexec.strategy.failureLimitHint')}
                />
                {form.failureLimit && (
                    <div className="ml-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <FormField id={`${id}-failures`} label={t('multiexec.strategy.failureCount')}>
                            <Input
                                id={`${id}-failures`}
                                type="number"
                                inputMode="numeric"
                                min={1}
                                value={form.failureCount}
                                onChange={(event) => set('failureCount', event.target.value)}
                                aria-invalid={invalid('failureCount')}
                                placeholder="—"
                                className={NUMBER_INPUT}
                            />
                        </FormField>
                        <FormField id={`${id}-failure-percent`} label={t('multiexec.strategy.failurePercent')}>
                            <Input
                                id={`${id}-failure-percent`}
                                type="number"
                                inputMode="numeric"
                                min={1}
                                max={100}
                                value={form.failurePercent}
                                onChange={(event) => set('failurePercent', event.target.value)}
                                aria-invalid={invalid('failurePercent')}
                                placeholder="—"
                                className={NUMBER_INPUT}
                            />
                        </FormField>
                    </div>
                )}
            </div>

            {plan.length > 0 && (
                <div className="space-y-2 border-t border-white/5 pt-3">
                    <BatchStrip sizes={sizes} canary={Boolean(check.strategy?.canary)} />
                    <ul className="space-y-0.5 text-[11px] text-zinc-400" aria-label={t('multiexec.plan.title')}>
                        {plan.map((line) => <li key={line}>{line}</li>)}
                    </ul>
                </div>
            )}
        </fieldset>
    );
}
