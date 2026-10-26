import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, GitCompare } from 'lucide-react';
import type { MultiExecServerRun } from '@shared/multiexec';
import { groupByOutput, type GroupMode, type OutputGroup } from '@shared/multiexecOutput';
import { Button } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { DiffView } from './DiffView';
import { serverErrorText } from './errors';
import { ServerOutput } from './ServerList';
import { StatusBadge } from './status';
import { plural } from './strategy';

type Group = OutputGroup<MultiExecServerRun>;

// Members listed before "and N more".
const MEMBERS_SHOWN = 12;

const letter = (index: number) => (index < 26 ? String.fromCharCode(65 + index) : `#${index + 1}`);

// The text compared between groups: stdout, then stderr under a marker.
export function comparableText(server: MultiExecServerRun): string {
    return server.stderr ? `${server.stdout}${server.stdout && !server.stdout.endsWith('\n') ? '\n' : ''}--- stderr ---\n${server.stderr}` : server.stdout;
}

function GroupCard({ group, index, majority, timeoutSec, comparing, onCompare }: {
    group: Group;
    index: number;
    majority: Group | null;
    timeoutSec: number;
    comparing: boolean;
    onCompare: () => void;
}) {
    const t = useT();
    const id = useId();
    const [open, setOpen] = useState(index === 0 && group.kind === 'output');
    const [allMembers, setAllMembers] = useState(false);
    const diffRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (comparing) diffRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }, [comparing]);
    const representative = group.members[0];
    const failure = group.kind === 'none' ? serverErrorText(representative, timeoutSec, t) : null;
    const isMajority = group === majority;
    const members = allMembers ? group.members : group.members.slice(0, MEMBERS_SHOWN);
    const canCompare = group.kind === 'output' && majority !== null && !isMajority;
    const count = group.members.length;

    return (
        <li className={cn('rounded-xl border bg-white/[0.02]', comparing ? 'border-brand-500/40' : 'border-white/5')}>
            <div className="flex items-center gap-2 pr-2">
                <button
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    aria-expanded={open}
                    aria-controls={`${id}-panel`}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left focus-ring"
                >
                    <ChevronRight className={cn('h-4 w-4 shrink-0 text-zinc-500 transition-transform', open && 'rotate-90')} aria-hidden="true" />
                    <span
                        className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold',
                            group.kind === 'none' ? 'bg-white/[0.06] text-zinc-400' : isMajority ? 'bg-brand-500/15 text-brand-200' : 'bg-amber-500/15 text-amber-200'
                        )}
                        aria-hidden="true"
                    >
                        {group.kind === 'none' ? '–' : letter(index)}
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-zinc-100">
                            {group.kind === 'none'
                                ? (failure?.message ?? t(`multiexec.groups.none.${group.status}`))
                                : t(isMajority ? 'multiexec.groups.majority' : 'multiexec.groups.variant', { letter: letter(index) })}
                        </span>
                        <span className="block truncate text-[11px] text-zinc-500">
                            {t(count === 1 ? 'multiexec.groups.servers.one' : 'multiexec.groups.servers.other', { count })}
                            {group.kind === 'output' && group.exitCode !== null ? ` · ${t('multiexec.results.exit', { code: group.exitCode })}` : ''}
                        </span>
                    </span>
                    <StatusBadge status={group.status} />
                </button>
                {canCompare && (
                    <Button size="sm" variant={comparing ? 'secondary' : 'subtle'} onClick={onCompare} aria-pressed={comparing} aria-controls={`${id}-diff`}>
                        <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('multiexec.groups.compare', { letter: 'A' })}
                    </Button>
                )}
            </div>

            {(open || comparing) && (
                <div id={`${id}-panel`} className="space-y-3 border-t border-white/5 px-3 py-3">
                    <ul className="flex flex-wrap gap-1" aria-label={t('multiexec.groups.members')}>
                        {members.map((server) => (
                            <li key={server.serverId} className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[11px] text-zinc-200" title={server.host}>
                                {server.name}
                            </li>
                        ))}
                        {group.members.length > MEMBERS_SHOWN && (
                            <li>
                                <button type="button" onClick={() => setAllMembers((value) => !value)} className="rounded-md px-1.5 py-0.5 text-[11px] text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline focus-ring">
                                    {allMembers ? t('multiexec.groups.fewer') : t('multiexec.groups.more', { count: group.members.length - MEMBERS_SHOWN })}
                                </button>
                            </li>
                        )}
                    </ul>
                    {comparing && majority ? (
                        <div id={`${id}-diff`} ref={diffRef}>
                            <DiffView
                                base={comparableText(majority.members[0])}
                                other={comparableText(representative)}
                                baseLabel={t('multiexec.groups.label', { letter: 'A' })}
                                otherLabel={t('multiexec.groups.label', { letter: letter(index) })}
                                trimmed={majority.members[0].outputTrimmed || representative.outputTrimmed}
                            />
                        </div>
                    ) : (
                        <ServerOutput server={representative} timeoutSec={timeoutSec} />
                    )}
                </div>
            )}
        </li>
    );
}

// The finished servers grouped by what they printed ("38 identical, 2 different").
export function OutputGroups({ servers, mode, timeoutSec }: { servers: readonly MultiExecServerRun[]; mode: GroupMode; timeoutSec: number }) {
    const t = useT();
    const [comparing, setComparing] = useState<string | null>(null);
    const groups = groupByOutput(servers, mode);
    const outputGroups = groups.filter((group) => group.kind === 'output');
    const majority = outputGroups[0] ?? null;
    const different = outputGroups.slice(1).reduce((sum, group) => sum + group.members.length, 0);
    const without = groups.filter((group) => group.kind === 'none').reduce((sum, group) => sum + group.members.length, 0);
    const pending = servers.filter((server) => server.status === 'queued' || server.status === 'running').length;

    const summary = [
        majority && (different === 0
            ? t(majority.members.length === 1 ? 'multiexec.groups.oneServer' : 'multiexec.groups.allSame', { count: majority.members.length })
            : t('multiexec.groups.summary', {
                identical: plural(t, 'multiexec.groups.identical', majority.members.length),
                different: plural(t, 'multiexec.groups.different', different)
            })),
        without > 0 && t('multiexec.groups.without', { count: without }),
        pending > 0 && t('multiexec.groups.pending', { count: pending })
    ].filter(Boolean).join(' · ');

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            <p role="status" className="text-xs text-zinc-300">{summary || t('multiexec.groups.nothingYet')}</p>
            <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin" aria-label={t('multiexec.groups.title')}>
                {groups.map((group) => {
                    const index = outputGroups.indexOf(group);
                    return (
                        <GroupCard
                            key={group.key}
                            group={group}
                            index={index}
                            majority={majority}
                            timeoutSec={timeoutSec}
                            comparing={comparing === group.key}
                            onCompare={() => setComparing((current) => (current === group.key ? null : group.key))}
                        />
                    );
                })}
            </ul>
        </div>
    );
}
