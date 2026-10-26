import { useId, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { ServerSummary } from '@shared/types';
import { Button, Input, Select } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { FieldGroup } from '@/features/snippets/public';

const ALL = '';
const NO_GROUP = '\u0000none';

interface TargetPickerProps {
    // SSH-capable servers only.
    servers: ServerSummary[];
    selected: ReadonlySet<number>;
    onChange: (selected: Set<number>) => void;
}

export function filterServers(servers: ServerSummary[], search: string, group: string, tag: string): ServerSummary[] {
    const needle = search.trim().toLowerCase();
    return servers.filter((server) => {
        if (group === NO_GROUP ? Boolean(server.group_name) : group && server.group_name !== group) return false;
        if (tag && !(server.tags ?? []).includes(tag)) return false;
        if (!needle) return true;
        return [server.name, server.ip, server.group_name ?? '', ...(server.tags ?? [])].some((text) => text.toLowerCase().includes(needle));
    });
}

export function TargetPicker({ servers, selected, onChange }: TargetPickerProps) {
    const t = useT();
    const id = useId();
    const [search, setSearch] = useState('');
    const [group, setGroup] = useState(ALL);
    const [tag, setTag] = useState(ALL);

    const groups = useMemo(() => [...new Set(servers.map((server) => server.group_name).filter((name): name is string => Boolean(name)))].sort(), [servers]);
    const tags = useMemo(() => [...new Set(servers.flatMap((server) => server.tags ?? []))].sort(), [servers]);
    const visible = filterServers(servers, search, group, tag);
    const hiddenSelected = [...selected].filter((serverId) => !visible.some((server) => server.id === serverId)).length;
    const allVisibleSelected = visible.length > 0 && visible.every((server) => selected.has(server.id));

    const toggle = (serverId: number) => {
        const next = new Set(selected);
        if (next.has(serverId)) next.delete(serverId);
        else next.add(serverId);
        onChange(next);
    };

    const selectVisible = () => onChange(new Set([...selected, ...visible.map((server) => server.id)]));
    const clearVisible = () => onChange(new Set([...selected].filter((serverId) => !visible.some((server) => server.id === serverId))));

    return (
        <section aria-labelledby={`${id}-title`} className="flex min-h-0 flex-col gap-3">
            <div className="flex items-baseline justify-between gap-2">
                <h3 id={`${id}-title`} className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('multiexec.targets.title')}</h3>
                <span className="text-xs text-zinc-400" aria-live="polite">{t('multiexec.targets.selected', { count: selected.size })}</span>
            </div>

            <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                <Input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('multiexec.targets.search')}
                    aria-label={t('multiexec.targets.search')}
                    aria-controls={`${id}-list`}
                    className="h-8 py-1 pl-8 text-xs"
                />
            </div>

            {(groups.length > 0 || tags.length > 0) && (
                <div className="grid grid-cols-2 gap-2">
                    {groups.length > 0 && (
                        <FieldGroup labelId={`${id}-group`} label={t('multiexec.targets.group')}>
                            <Select
                                value={group}
                                onChange={setGroup}
                                className="h-8 py-1 text-xs"
                                options={[
                                    { value: ALL, label: t('multiexec.targets.allGroups') },
                                    ...groups.map((name) => ({ value: name, label: name })),
                                    { value: NO_GROUP, label: t('multiexec.targets.noGroup') }
                                ]}
                            />
                        </FieldGroup>
                    )}
                    {tags.length > 0 && (
                        <FieldGroup labelId={`${id}-tag`} label={t('multiexec.targets.tag')}>
                            <Select
                                value={tag}
                                onChange={setTag}
                                className="h-8 py-1 text-xs"
                                options={[{ value: ALL, label: t('multiexec.targets.allTags') }, ...tags.map((name) => ({ value: name, label: name }))]}
                            />
                        </FieldGroup>
                    )}
                </div>
            )}

            <div className="flex items-center gap-2">
                <Button size="sm" variant="subtle" onClick={selectVisible} disabled={allVisibleSelected}>{t('multiexec.targets.selectVisible', { count: visible.length })}</Button>
                <Button size="sm" variant="ghost" onClick={clearVisible} disabled={!visible.some((server) => selected.has(server.id))}>{t('multiexec.targets.clear')}</Button>
            </div>

            <ul id={`${id}-list`} aria-labelledby={`${id}-title`} className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 scrollbar-thin">
                {visible.map((server) => {
                    const checkboxId = `${id}-server-${server.id}`;
                    const checked = selected.has(server.id);
                    return (
                        <li key={server.id}>
                            <label
                                htmlFor={checkboxId}
                                className={cn(
                                    'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border px-2.5 py-2 transition-colors',
                                    checked ? 'border-brand-500/40 bg-brand-500/[0.07]' : 'border-white/5 hover:bg-white/[0.03]'
                                )}
                            >
                                <input
                                    id={checkboxId}
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggle(server.id)}
                                    className="row-span-2 h-4 w-4 accent-brand-500"
                                />
                                <span className="truncate text-sm font-medium text-zinc-100">{server.name}</span>
                                <span className="row-span-2 rounded bg-white/[0.06] px-1 text-[10px] uppercase text-zinc-400">{server.type}</span>
                                <span className="col-start-2 truncate font-mono text-[11px] text-zinc-400">
                                    {`${server.username ? `${server.username}@` : ''}${server.ip}${server.group_name ? ` · ${server.group_name}` : ''}`}
                                </span>
                            </label>
                        </li>
                    );
                })}
                {visible.length === 0 && (
                    <li className="px-2 py-6 text-center text-xs text-zinc-500">
                        {servers.length ? t('multiexec.targets.noMatch') : t('multiexec.targets.none')}
                    </li>
                )}
            </ul>
            {hiddenSelected > 0 && <p className="text-[11px] text-zinc-500">{t('multiexec.targets.hiddenSelected', { count: hiddenSelected })}</p>}
        </section>
    );
}
