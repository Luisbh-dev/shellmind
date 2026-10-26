import { MULTIEXEC_LIMITS, planBatches, type MultiExecStrategy } from '@shared/multiexec';
import type { TranslateFn } from '@/i18n';

// The rollout settings of the composer, as typed (text inputs), and the
// strategy they describe.

export type StrategyForm = {
    mode: 'parallel' | 'rolling';
    concurrency: string;
    batchSize: string;
    batchUnit: 'servers' | 'percent';
    pauseSec: string;
    canary: boolean;
    canaryCount: string;
    canaryThen: 'pause' | 'continue';
    failureLimit: boolean;
    failureCount: string;
    failurePercent: string;
};

export const DEFAULT_STRATEGY_FORM: StrategyForm = {
    mode: 'parallel',
    concurrency: String(MULTIEXEC_LIMITS.defaultConcurrency),
    batchSize: '25',
    batchUnit: 'percent',
    pauseSec: '0',
    canary: false,
    canaryCount: '1',
    canaryThen: 'pause',
    failureLimit: false,
    failureCount: '1',
    failurePercent: ''
};

// A whole number from min to max, or null; '' is `empty`.
export function parseBounded(text: string, min: number, max: number): number | null {
    if (!/^\d+$/.test(text.trim())) return null;
    const value = Number(text);
    return value >= min && value <= max ? value : null;
}

export function formFromStrategy(strategy: MultiExecStrategy): StrategyForm {
    return {
        mode: strategy.batch ? 'rolling' : 'parallel',
        concurrency: String(strategy.concurrency),
        batchSize: String(strategy.batch?.size ?? DEFAULT_STRATEGY_FORM.batchSize),
        batchUnit: strategy.batch?.unit ?? DEFAULT_STRATEGY_FORM.batchUnit,
        pauseSec: String(strategy.pauseSec),
        canary: Boolean(strategy.canary),
        canaryCount: String(strategy.canary?.count ?? 1),
        canaryThen: strategy.canary?.onSuccess ?? 'pause',
        failureLimit: Boolean(strategy.failureLimit),
        failureCount: strategy.failureLimit?.count == null ? '' : String(strategy.failureLimit.count),
        failurePercent: strategy.failureLimit?.percent == null ? '' : String(strategy.failureLimit.percent)
    };
}

// The rollout of a job run again on `count` of its servers: a canary that
// would take all of them goes (the rerun is what comes after a canary), and
// a batch size in servers stays within them.
export function strategyForRerun(strategy: MultiExecStrategy, count: number): MultiExecStrategy {
    const canary = strategy.canary && strategy.canary.count < count ? strategy.canary : null;
    const batch = strategy.batch?.unit === 'servers' && strategy.batch.size > count ? { ...strategy.batch, size: Math.max(1, count) } : strategy.batch;
    return { ...strategy, canary, batch };
}

export type StrategyCheck = {
    strategy: MultiExecStrategy | null;
    problems: string[];
    // The fields with a problem (aria-invalid).
    invalid: ReadonlySet<keyof StrategyForm>;
};

export function strategyFromForm(form: StrategyForm, targets: number, t: TranslateFn): StrategyCheck {
    const problems: string[] = [];
    const invalid = new Set<keyof StrategyForm>();
    const flag = (field: keyof StrategyForm, problem: string) => {
        invalid.add(field);
        problems.push(problem);
    };

    const concurrency = parseBounded(form.concurrency, 1, MULTIEXEC_LIMITS.maxConcurrency);
    if (concurrency === null) flag('concurrency', t('multiexec.compose.badConcurrency', { max: MULTIEXEC_LIMITS.maxConcurrency }));

    let batch: MultiExecStrategy['batch'] = null;
    let pauseSec = 0;
    if (form.mode === 'rolling') {
        const max = form.batchUnit === 'percent' ? 100 : MULTIEXEC_LIMITS.maxTargets;
        const size = parseBounded(form.batchSize, 1, max);
        if (size === null) flag('batchSize', t(form.batchUnit === 'percent' ? 'multiexec.strategy.badBatchPercent' : 'multiexec.strategy.badBatchSize', { max }));
        else batch = { size, unit: form.batchUnit };
        const pause = form.pauseSec.trim() === '' ? 0 : parseBounded(form.pauseSec, 0, MULTIEXEC_LIMITS.maxPauseSec);
        if (pause === null) flag('pauseSec', t('multiexec.strategy.badPause', { max: MULTIEXEC_LIMITS.maxPauseSec }));
        else pauseSec = pause;
    }

    let canary: MultiExecStrategy['canary'] = null;
    if (form.canary) {
        if (targets > 0 && targets < 2) {
            flag('canaryCount', t('multiexec.strategy.canaryNeedsTwo'));
        } else {
            const count = parseBounded(form.canaryCount, 1, Math.max(1, targets - 1));
            if (count === null) flag('canaryCount', t('multiexec.strategy.badCanary', { max: Math.max(1, targets - 1) }));
            else canary = { count, onSuccess: form.canaryThen };
        }
    }

    let failureLimit: MultiExecStrategy['failureLimit'] = null;
    if (form.failureLimit) {
        const count = form.failureCount.trim() === '' ? null : parseBounded(form.failureCount, 1, MULTIEXEC_LIMITS.maxTargets);
        const percent = form.failurePercent.trim() === '' ? null : parseBounded(form.failurePercent, 1, 100);
        if (form.failureCount.trim() !== '' && count === null) flag('failureCount', t('multiexec.strategy.badFailureCount', { max: MULTIEXEC_LIMITS.maxTargets }));
        if (form.failurePercent.trim() !== '' && percent === null) flag('failurePercent', t('multiexec.strategy.badFailurePercent'));
        if (form.failureCount.trim() === '' && form.failurePercent.trim() === '') flag('failureCount', t('multiexec.strategy.needFailureLimit'));
        if (count !== null || percent !== null) failureLimit = { count, percent };
    }

    return {
        strategy: problems.length || concurrency === null ? null : { concurrency, batch, pauseSec, canary, failureLimit },
        problems,
        invalid
    };
}

// The `.one` or `.other` form of `key` for `count` (passed as {count}).
export const plural = (t: TranslateFn, key: string, count: number, params: Record<string, string | number> = {}) =>
    t(`${key}.${count === 1 ? 'one' : 'other'}`, { count, ...params });

// The plan in a few sentences ("Canary: 1 server first, then…").
export function describePlan(strategy: MultiExecStrategy, total: number, t: TranslateFn): string[] {
    const sizes = planBatches(total, strategy);
    const lines: string[] = [];
    const rest = strategy.canary ? sizes.slice(1) : sizes;
    if (strategy.canary && sizes.length > 1) {
        lines.push(plural(t, 'multiexec.plan.canary', strategy.canary.count, {
            then: strategy.canary.onSuccess === 'pause'
                ? t('multiexec.plan.thenApprove')
                : strategy.pauseSec > 0 ? t('multiexec.plan.thenWaitContinue', { seconds: strategy.pauseSec }) : t('multiexec.plan.thenContinue')
        }));
    }
    const left = rest.reduce((sum, size) => sum + size, 0);
    if (rest.length <= 1) {
        lines.push(plural(t, strategy.canary ? 'multiexec.plan.restAtOnce' : 'multiexec.plan.allAtOnce', left, { concurrency: strategy.concurrency }));
    } else {
        const size = Math.max(...rest);
        lines.push(plural(t, 'multiexec.plan.batches', size, { batches: rest.length, size, concurrency: strategy.concurrency })
            + (strategy.pauseSec > 0 ? ` ${t('multiexec.plan.pause', { seconds: strategy.pauseSec })}` : ''));
    }
    if (strategy.failureLimit) {
        const { count, percent } = strategy.failureLimit;
        lines.push(count !== null && percent !== null
            ? plural(t, 'multiexec.plan.stopAfterBoth', count, { percent })
            : count !== null ? plural(t, 'multiexec.plan.stopAfter', count) : t('multiexec.plan.stopAfterPercent', { percent: percent ?? 0 }));
    }
    return lines;
}
