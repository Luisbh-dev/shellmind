import { useMemo, useState } from 'react';
import { SearchField, Segmented } from '@/features/ops/ui';
import { useRemote } from '@/features/ops/useRemote';
import { useT } from '@/i18n';
import { k8sApi } from './api';
import { EventList } from './EventList';
import { isAllNamespaces } from './model';
import { K8sErrorNotice, TableSkeleton, useViewRefresh, type RefreshSignal } from './ui';

type EventsViewProps = {
    serverId: number;
    context: string;
    namespace: string;
    refresh: RefreshSignal;
    active: boolean;
    onOpenPod: (name: string, namespace: string) => void;
};

type Filter = 'all' | 'warnings';

export function EventsView({ serverId, context, namespace, refresh, active, onOpenPod }: EventsViewProps) {
    const t = useT();
    const [filter, setFilter] = useState<Filter>('all');
    const [query, setQuery] = useState('');
    const events = useRemote((signal) => k8sApi.events(serverId, context, namespace, signal), `events:${serverId}:${context}:${namespace}`);
    useViewRefresh(events, refresh, active);

    const list = useMemo(() => events.data ?? [], [events.data]);
    const warnings = list.filter((event) => event.type === 'Warning').length;
    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return list.filter((event) => (filter === 'all' || event.type === 'Warning')
            && (!needle || [event.reason, event.message, event.object.name, event.object.kind].some((value) => value.toLowerCase().includes(needle))));
    }, [list, filter, query]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
                <SearchField value={query} onChange={setQuery} label={t('k8s.events.search')} className="w-full min-w-[10rem] max-w-xs flex-1" />
                <Segmented<Filter>
                    label={t('k8s.events.filterLabel')}
                    value={filter}
                    onChange={setFilter}
                    options={[
                        { value: 'all', label: t('k8s.events.filter.all'), count: list.length },
                        { value: 'warnings', label: t('k8s.events.filter.warnings'), count: warnings }
                    ]}
                />
            </div>
            {events.error && events.data ? <K8sErrorNotice error={events.error} title={t('k8s.refreshFailed')} onRetry={events.reload} className="mx-4 mt-3" /> : null}
            <div className="min-h-0 flex-1 overflow-auto">
                {events.error && !events.data ? (
                    <K8sErrorNotice error={events.error} onRetry={events.reload} className="m-4" />
                ) : events.loading && !events.data ? (
                    <TableSkeleton />
                ) : (
                    <EventList events={visible} showNamespace={isAllNamespaces(namespace)} onOpenPod={onOpenPod} />
                )}
            </div>
        </div>
    );
}
