// Settings of the fleet checks: reachability and health checks on or off,
// how often, notifications and the servers left out. In Settings > General
// and on the fleet board.
import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Bell, HeartPulse } from 'lucide-react';
import { FLEET_INTERVALS, reachIntervalMinutes, type FleetIntervalMinutes, type FleetSettings as Settings } from '@shared/fleet';
import { Button, Checkbox, Field, Select, Spinner, useToast } from '@/components/ui';
import { useT, type TranslateFn } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { saveFleetSettings } from './api';
import { setFleetSettings, useFleetStore } from './feed';
import { notificationSupport, requestNotificationPermission, type NotificationSupport } from './notifications';

export function intervalLabel(t: TranslateFn, minutes: number): string {
    return minutes === 60 ? t('fleet.interval.hour') : t('fleet.interval.minutes', { count: minutes });
}

// The saved settings: the feed's, or read once when it has none yet.
function useSettings(): { settings: Settings | null; failed: boolean } {
    const settings = useFleetStore((state) => state.settings);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        if (settings) return;
        let current = true;
        api.data<Settings>('/api/fleet/settings').then(
            (loaded) => {
                if (current && !useFleetStore.getState().settings) setFleetSettings(loaded);
            },
            () => {
                if (current) setFailed(true);
            }
        );
        return () => {
            current = false;
        };
    }, [settings]);
    return { settings, failed };
}

export function FleetSettings({ className, showHeading = true }: { className?: string; showHeading?: boolean }) {
    const t = useT();
    const toast = useToast();
    const headingId = useId();
    const { settings, failed } = useSettings();
    const live = useFleetStore((state) => state.status === 'live');
    const snapshots = useFleetStore((state) => state.snapshots);
    const [saving, setSaving] = useState(false);
    const [permission, setPermission] = useState<NotificationSupport>(() => notificationSupport());

    const save = async (update: Partial<Settings>) => {
        setSaving(true);
        try {
            setFleetSettings(await saveFleetSettings(update));
        } catch (err) {
            toast.error(t('fleet.toasts.saveFailed'), err instanceof ApiError ? err.message : undefined);
        } finally {
            setSaving(false);
        }
    };

    // Asked from the click that turns the alerts on, as browsers require.
    const askPermission = async () => {
        setPermission(await requestNotificationPermission());
    };

    const heading = showHeading && (
        <h3 id={headingId} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-300">
            <HeartPulse className="h-3.5 w-3.5" aria-hidden="true" />
            {t('fleet.settings.heading')}
        </h3>
    );

    if (!settings) {
        return (
            <section aria-labelledby={showHeading ? headingId : undefined} className={cn('space-y-3', className)}>
                {heading}
                {failed
                    ? <p role="alert" className="text-xs text-rose-300">{t('fleet.settings.loadFailed')}</p>
                    : <Spinner className="h-4 w-4 text-zinc-400" />}
            </section>
        );
    }

    // The servers on the board left out (the feed knows which are there).
    const excluded = live
        ? Object.values(snapshots).filter((snapshot) => !snapshot.monitored).length
        : settings.excludedServerIds.length;
    return (
        <section aria-labelledby={showHeading ? headingId : undefined} aria-busy={saving || undefined} className={cn('space-y-4', className)}>
            {heading}
            <Checkbox
                checked={settings.reachability}
                disabled={saving || settings.enabled}
                onChange={(reachability) => {
                    if (reachability && settings.notifications) void askPermission();
                    void save({ reachability });
                }}
                label={t('fleet.settings.reachability')}
                description={settings.enabled
                    ? t('fleet.settings.reachabilityCovered')
                    : t('fleet.settings.reachabilityHint', { interval: intervalLabel(t, reachIntervalMinutes(settings)) })}
            />
            <Checkbox
                checked={settings.enabled}
                disabled={saving}
                onChange={(enabled) => {
                    if (enabled && settings.notifications) void askPermission();
                    void save({ enabled });
                }}
                label={t('fleet.settings.enabled')}
                description={t('fleet.settings.enabledHint')}
            />
            <Field label={t('fleet.settings.interval')} className="max-w-[14rem]">
                <Select
                    value={String(settings.intervalMinutes)}
                    disabled={saving}
                    onChange={(value) => void save({ intervalMinutes: Number(value) as FleetIntervalMinutes })}
                    options={FLEET_INTERVALS.map((minutes) => ({ value: String(minutes), label: intervalLabel(t, minutes) }))}
                />
            </Field>
            <div className="space-y-2">
                <Checkbox
                    checked={settings.notifications}
                    disabled={saving}
                    onChange={(notifications) => {
                        if (notifications) void askPermission();
                        void save({ notifications });
                    }}
                    label={t('fleet.settings.notifications')}
                    description={t('fleet.settings.notificationsHint')}
                />
                {settings.notifications && permission === 'denied' && (
                    <p className="ml-6 flex items-start gap-1.5 text-xs text-amber-300">
                        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {t('fleet.settings.notificationsDenied')}
                    </p>
                )}
                {settings.notifications && permission === 'default' && (
                    <Button size="sm" variant="subtle" className="ml-6" onClick={() => void askPermission()}>
                        <Bell className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('fleet.settings.notificationsAllow')}
                    </Button>
                )}
            </div>
            {excluded > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                    <span>{excluded === 1 ? t('fleet.settings.excludedOne') : t('fleet.settings.excluded', { count: excluded })}</span>
                    <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save({ excludedServerIds: [] })}>
                        {t('fleet.settings.includeAll')}
                    </Button>
                </div>
            )}
            <p className="text-xs text-zinc-400">{t('fleet.settings.note')}</p>
        </section>
    );
}
