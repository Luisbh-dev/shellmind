import { useId, useMemo, useState } from 'react';
import { KeyRound, Search } from 'lucide-react';
import type { IdentitySummary } from '@shared/identities';
import type { ServerSummary } from '@shared/types';
import { Badge, Button, Input, Select } from '@/components/ui';
import { allGroups, allTags, filterServers } from '@/features/organization/organize';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { serverAddress } from './describe';

const ALL = '';
const NO_GROUP = '\u0000none';

interface ServerPickerProps {
    // The servers to choose from (SSH servers).
    servers: ServerSummary[];
    selected: ReadonlySet<number>;
    onChange: (selected: Set<number>) => void;
    // Names the identity each server uses, as a badge.
    identities: IdentitySummary[];
    // Accessible name of the list.
    label: string;
    disabled?: boolean;
}

// The sidebar's search (every word, accents ignored) and tag filter, plus the group.
function filter(servers: ServerSummary[], search: string, group: string, tag: string): ServerSummary[] {
    return filterServers(servers, search, tag ? [tag] : []).filter((server) => {
        const own = server.group_name?.trim() || null;
        return group === ALL || (group === NO_GROUP ? own === null : own === group);
    });
}

// A searchable checklist of servers (filter by group and tag), for
// installing a key on several servers or assigning an identity to them.
export function ServerPicker({ servers, selected, onChange, identities, label, disabled }: ServerPickerProps) {
    const t = useT();
    const id = useId();
    const [search, setSearch] = useState('');
    const [group, setGroup] = useState(ALL);
    const [tag, setTag] = useState(ALL);
    const groups = useMemo(() => allGroups(servers), [servers]);
    const tags = useMemo(() => allTags(servers), [servers]);
    const identityById = useMemo(() => new Map(identities.map((identity) => [identity.id, identity])), [identities]);
    const visible = filter(servers, search, group, tag);
    const allVisibleSelected = visible.length > 0 && visible.every((server) => selected.has(server.id));

    const toggle = (serverId: number) => {
        const next = new Set(selected);
        if (next.has(serverId)) next.delete(serverId);
        else next.add(serverId);
        onChange(next);
    };

    if (servers.length === 0) {
        return <p className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-xs text-zinc-400">{t('identities.picker.noServers')}</p>;
    }

    return (
        <div className="flex min-h-0 flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[10rem] flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                    <Input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={t('identities.picker.search')}
                        aria-label={t('identities.picker.search')}
                        aria-controls={`${id}-list`}
                        className="h-8 py-1 pl-8 text-xs"
                        disabled={disabled}
                    />
                </div>
                {groups.length > 0 && (
                    <div className="w-40">
                        <Select
                            value={group}
                            onChange={setGroup}
                            aria-label={t('identities.picker.group')}
                            className="h-8 py-1 text-xs"
                            disabled={disabled}
                            options={[
                                { value: ALL, label: t('identities.picker.allGroups') },
                                ...groups.map((name) => ({ value: name, label: name })),
                                { value: NO_GROUP, label: t('identities.picker.noGroup') }
                            ]}
                        />
                    </div>
                )}
                {tags.length > 0 && (
                    <div className="w-40">
                        <Select
                            value={tag}
                            onChange={setTag}
                            aria-label={t('identities.picker.tag')}
                            className="h-8 py-1 text-xs"
                            disabled={disabled}
                            options={[{ value: ALL, label: t('identities.picker.allTags') }, ...tags.map((name) => ({ value: name, label: `#${name}` }))]}
                        />
                    </div>
                )}
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-zinc-400" aria-live="polite">{t('identities.picker.selected', { count: selected.size, total: servers.length })}</span>
                <div className="flex items-center gap-1">
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        disabled={disabled || visible.length === 0 || allVisibleSelected}
                        onClick={() => onChange(new Set([...selected, ...visible.map((server) => server.id)]))}
                    >
                        {t('identities.picker.selectShown', { count: visible.length })}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        disabled={disabled || selected.size === 0}
                        onClick={() => onChange(new Set([...selected].filter((serverId) => !visible.some((server) => server.id === serverId))))}
                    >
                        {t('identities.picker.clear')}
                    </Button>
                </div>
            </div>

            <ul id={`${id}-list`} aria-label={label} className="max-h-60 min-h-0 space-y-1 overflow-y-auto rounded-lg border border-white/[0.06] bg-black/10 p-1.5 scrollbar-thin">
                {visible.length === 0 && <li className="px-2 py-4 text-center text-xs text-zinc-400">{t('identities.picker.noMatches')}</li>}
                {visible.map((server) => {
                    const inputId = `${id}-server-${server.id}`;
                    const identity = server.identity_id ? identityById.get(server.identity_id) : undefined;
                    const identityName = identity?.name;
                    return (
                        <li key={server.id}>
                            <label
                                htmlFor={inputId}
                                className={cn(
                                    'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-white/[0.04]',
                                    selected.has(server.id) && 'bg-brand-500/[0.07]',
                                    disabled && 'cursor-not-allowed opacity-60'
                                )}
                            >
                                <input
                                    id={inputId}
                                    type="checkbox"
                                    checked={selected.has(server.id)}
                                    disabled={disabled}
                                    onChange={() => toggle(server.id)}
                                    className="h-4 w-4 shrink-0 cursor-pointer rounded accent-brand-500 focus-ring"
                                />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm text-zinc-100">{server.name}</span>
                                    <span className="block truncate font-mono text-[11px] text-zinc-400">{serverAddress(server, identity?.username)}</span>
                                </span>
                                {identityName && (
                                    <Badge tone="brand" className="shrink-0" title={t('identities.picker.usesIdentity', { name: identityName })}>
                                        <KeyRound className="mr-0.5 inline h-3 w-3" aria-hidden="true" />
                                        {identityName}
                                    </Badge>
                                )}
                            </label>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
