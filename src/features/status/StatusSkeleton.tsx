import { Skeleton } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { CARD } from './Card';
import { CHART_GRID, CHART_WIDE, DETAIL_GRID, KPI_GRID } from './layout';

// The first load: the dashboard's own layout in placeholder blocks, so
// nothing jumps when the first sample arrives.

export function StatusSkeleton() {
    const t = useT();
    return (
        <div role="status" aria-label={t('status.loading')} className="flex flex-col gap-4">
            <div className={KPI_GRID}>
                {Array.from({ length: 4 }, (_, index) => (
                    <div key={index} className={cn(CARD, 'flex flex-col gap-3 p-4')}>
                        <Skeleton className="h-3 w-20" />
                        <Skeleton className="h-6 w-24" />
                        <Skeleton className="h-2 w-full rounded-full" />
                        <Skeleton className="h-3 w-32" />
                    </div>
                ))}
            </div>
            <div className={CHART_GRID}>
                {Array.from({ length: 3 }, (_, index) => (
                    <div key={index} className={cn(CARD, 'flex flex-col gap-3 p-4', index === 2 && CHART_WIDE)}>
                        <div className="flex justify-between">
                            <Skeleton className="h-3.5 w-28" />
                            <Skeleton className="h-3 w-24" />
                        </div>
                        <Skeleton className="h-32 w-full" />
                    </div>
                ))}
            </div>
            <div className={DETAIL_GRID}>
                <div className={cn(CARD, 'flex flex-col gap-3 p-4')}>
                    <Skeleton className="h-3.5 w-32" />
                    {Array.from({ length: 5 }, (_, index) => (
                        <Skeleton key={index} className="h-4 w-full" />
                    ))}
                </div>
                <div className={cn(CARD, 'flex flex-col gap-3 p-4')}>
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-4/5" />
                </div>
            </div>
        </div>
    );
}
