import type { ReactNode } from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, Clock3, Cpu, HelpCircle, History, Monitor, RefreshCw, Server, Stethoscope, Users } from 'lucide-react';
import type { StatusSnapshot } from '@shared/status';
import { AskAiButton, askAi } from '@/components/AskAiButton';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatPercent } from '@/lib/format';
import { formatAgo, formatLoad, formatUptime } from './format';
import { classify, THRESHOLDS, type Health, type HealthIssue } from './thresholds';
import { toneColor, viz } from './vizTheme';

// The top of the dashboard: the server, its overall health with the reasons,
// whether the numbers are live, and the host facts (hostname, OS, kernel,
// uptime, logged-in users, failed units).

export type LiveState = 'live' | 'stale' | 'error' | 'paused';

const HEALTH_ICON = { ok: CheckCircle2, warn: AlertTriangle, critical: AlertOctagon, unknown: HelpCircle };
// The rest folds into "+N more"; six fit one line of a wide panel.
const MAX_ISSUES = 6;

function healthColor(tone: Health['tone'], alpha?: number): string {
    if (tone === 'unknown') return alpha === undefined ? 'rgb(var(--c-zinc-500))' : `rgb(var(--c-zinc-500) / ${alpha})`;
    return tone === 'ok' ? viz.good(alpha) : toneColor(tone, alpha);
}

function useIssueText() {
    const t = useT();
    const language = useLanguage();
    return (issue: HealthIssue) => {
        const value = formatPercent(issue.value, language);
        if (issue.metric === 'failedUnits') {
            return issue.value === 1 ? t('status.health.issues.failedUnitsOne') : t('status.health.issues.failedUnits', { count: issue.value });
        }
        if (issue.metric === 'load') return t('status.health.issues.load', { value: formatLoad(issue.value, language) });
        if (issue.metric === 'disk') {
            return issue.mount !== undefined ? t('status.health.issues.disk', { mount: issue.mount, value }) : t('status.health.issues.diskTotal', { value });
        }
        return t(`status.health.issues.${issue.metric}`, { value });
    };
}

// The verdict next to the server name: icon, word and colour together. While
// the values are stale (`staleSince`: when they were read) it turns neutral
// and says it is the last known one: an out-of-date "Healthy" in green would
// be the loudest thing on the page of a host that stopped answering.
export function HealthBadge({ health, staleSince }: { health: Health; staleSince?: string }) {
    const t = useT();
    const issueText = useIssueText();
    const stale = staleSince !== undefined;
    const Icon = stale ? History : HEALTH_ICON[health.tone];
    const tone = stale ? 'unknown' : health.tone;
    const state = t(`status.health.${health.tone}`);
    const detail = health.tone === 'ok'
        ? t('status.health.okDetail')
        : health.tone === 'unknown'
            ? t('status.health.unknownDetail')
            : health.issues.map(issueText).join(' · ');
    return (
        <span
            className="inline-flex min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-full py-0.5 pl-1.5 pr-2.5 text-xs font-semibold text-zinc-100"
            style={{ backgroundColor: healthColor(tone, 0.14) }}
            title={stale ? `${t('status.state.staleHint', { time: staleSince })}\n${detail}` : detail}
        >
            <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: healthColor(tone) }} aria-hidden="true" />
            <span className="sr-only">{stale ? t('status.health.labelStale', { state, time: staleSince }) : t('status.health.label', { state })}</span>
            <span aria-hidden="true" className="truncate">{stale ? t('status.health.lastKnown', { state }) : state}</span>
        </span>
    );
}

// What pulls the verdict down, worst first.
export function HealthIssues({ health }: { health: Health }) {
    const t = useT();
    const issueText = useIssueText();
    const shown = health.issues.slice(0, MAX_ISSUES);
    const hidden = health.issues.slice(MAX_ISSUES);
    return (
        <ul aria-label={t('status.health.issuesLabel')} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-300">
            {shown.map((issue, index) => {
                // The shape tells warn from critical, not only the colour.
                const Icon = HEALTH_ICON[issue.tone];
                return (
                    <li
                        key={`${issue.metric}-${issue.mount ?? index}`}
                        className="inline-flex min-w-0 items-center gap-1.5"
                        title={issue.metric === 'failedUnits' ? t('status.facts.failedUnitsHint') : undefined}
                    >
                        <Icon className="h-3 w-3 shrink-0" style={{ color: toneColor(issue.tone) }} aria-hidden="true" />
                        <span className="sr-only">{t(`status.tone.${issue.tone}`)}:</span>
                        <span className="truncate">{issueText(issue)}</span>
                    </li>
                );
            })}
            {hidden.length > 0 && (
                <li className="text-zinc-500" title={hidden.map(issueText).join(' · ')}>
                    <span aria-hidden="true">{t('status.health.more', { count: hidden.length })}</span>
                    <span className="sr-only">{hidden.map((issue) => `${t(`status.tone.${issue.tone}`)}: ${issueText(issue)}`).join(', ')}</span>
                </li>
            )}
        </ul>
    );
}

function Fact({ icon, children, title, label }: { icon: ReactNode; children: ReactNode; title?: string; label?: string }) {
    return (
        <li className="inline-flex min-w-0 max-w-full items-center gap-1.5" title={title}>
            <span className="shrink-0 text-zinc-500 [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden="true">{icon}</span>
            {label && <span className="sr-only">{label}:</span>}
            <span className="truncate">{children}</span>
        </li>
    );
}

function Chip({ icon, children, title }: { icon: ReactNode; children: ReactNode; title?: string }) {
    return (
        <li
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] px-2 py-0.5 text-[11px] font-medium text-zinc-200"
            title={title}
        >
            <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3" aria-hidden="true">{icon}</span>
            {children}
        </li>
    );
}

// Failed units show here only while they are within their limit: past it
// they are a health issue, listed (with their count) in the row above.
export function HostFacts({ snapshot }: { snapshot: StatusSnapshot }) {
    const t = useT();
    const users = snapshot.loggedInUsers;
    const failed = snapshot.failedUnits;
    const failedOk = failed !== null && classify(failed, THRESHOLDS.failedUnits) === 'ok';
    return (
        <ul aria-label={t('status.facts.label')} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-400">
            <Fact icon={<Server />} label={t('status.facts.hostname')}>{snapshot.hostname}</Fact>
            <Fact icon={<Monitor />} label={t('status.facts.os')}>{snapshot.os}</Fact>
            {snapshot.kernel && (
                <Fact icon={<Cpu />} title={snapshot.kernel}>
                    {t(snapshot.platform === 'windows' ? 'status.facts.version' : 'status.facts.kernel', { value: snapshot.kernel })}
                </Fact>
            )}
            {snapshot.uptimeSeconds !== null && <Fact icon={<Clock3 />}>{t('status.facts.uptime', { value: formatUptime(snapshot.uptimeSeconds, t) })}</Fact>}
            {(users !== null || failedOk) && (
                <li className="contents">
                    <ul className="flex flex-wrap items-center gap-1.5">
                        {users !== null && (
                            <Chip icon={<Users />}>
                                {users === 0 ? t('status.facts.usersNone') : users === 1 ? t('status.facts.usersOne') : t('status.facts.users', { count: users })}
                            </Chip>
                        )}
                        {failedOk && (
                            <Chip icon={<CheckCircle2 />} title={t('status.facts.failedUnitsHint')}>
                                {failed === 0 ? t('status.facts.noFailedUnits') : failed === 1 ? t('status.facts.failedUnitsOne') : t('status.facts.failedUnits', { count: failed })}
                            </Chip>
                        )}
                    </ul>
                </li>
            )}
        </ul>
    );
}

// AI help from the header (W7-S5): "Ask AI" about what the dashboard shows,
// and the triage pack. Both open the chat with the evidence attached; nothing
// goes to the AI until the user sends it.
export function StatusAiActions({ serverId }: { serverId: number }) {
    const t = useT();
    return (
        <div role="group" aria-label={t('chat.diagnose.groupLabel')} className="flex shrink-0 items-center gap-1.5">
            <AskAiButton
                serverId={serverId}
                attachment={{ kind: 'status' }}
                variant="icon"
                label={t('chat.diagnose.askLabel')}
                hint={t('chat.diagnose.askHint')}
                className="border border-white/[0.08] bg-white/[0.03]"
            />
            <button
                type="button"
                onClick={() => askAi(t, serverId, { kind: 'triage' })}
                title={t('chat.diagnose.triageHint')}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-brand-500/30 bg-brand-500/10 px-2.5 text-xs font-medium text-brand-100 transition-colors hover:bg-brand-500/20 focus-ring"
            >
                <Stethoscope className="h-3.5 w-3.5 text-brand-300" aria-hidden="true" />
                {t('chat.diagnose.triage')}
            </button>
        </div>
    );
}

const LIVE_DOT: Record<LiveState, string> = {
    live: viz.good(),
    stale: toneColor('warn'),
    error: toneColor('critical'),
    paused: 'rgb(var(--c-zinc-500))'
};

type LiveIndicatorProps = {
    state: LiveState;
    hint?: string;
    lastSuccess: number | null;
    now: number;
    // A refresh the user asked for is running. The background polls do not
    // spin the button or grey it out: "Updated …" already tells they happen.
    busy: boolean;
    canRefresh: boolean;
    onRefresh: () => void;
};

export function LiveIndicator({ state, hint, lastSuccess, now, busy, canRefresh, onRefresh }: LiveIndicatorProps) {
    const t = useT();
    return (
        <div className="flex shrink-0 items-center gap-2.5 text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-zinc-200" title={hint}>
                <span className="relative inline-flex h-2 w-2" aria-hidden="true">
                    {state === 'live' && (
                        <span className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" style={{ backgroundColor: LIVE_DOT.live, animationDuration: '2.4s' }} />
                    )}
                    <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: LIVE_DOT[state] }} />
                </span>
                {t(`status.state.${state}`)}
            </span>
            {lastSuccess !== null && (
                <span className="hidden tabular-nums text-zinc-500 [@container(min-width:30rem)]:inline">
                    {t('status.updated', { ago: formatAgo(lastSuccess, now, t) })}
                </span>
            )}
            {/* aria-disabled, not disabled: a refresh started from the keyboard keeps the focus. */}
            <button
                type="button"
                onClick={() => {
                    if (!busy && canRefresh) onRefresh();
                }}
                aria-disabled={busy || !canRefresh || undefined}
                aria-label={t('status.refresh')}
                title={t('status.refresh')}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-zinc-100 focus-ring aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-white/[0.03]"
            >
                <RefreshCw className={cn('h-3.5 w-3.5', busy && 'motion-safe:animate-spin')} aria-hidden="true" />
            </button>
        </div>
    );
}
