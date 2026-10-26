import { useEffect } from 'react';
import { countStatuses, isJobFinal, type MultiExecJobStatus, type MultiExecPauseReason } from '@shared/multiexec';
import { useToast } from '@/components/ui';
import { t } from '@/i18n';
import { stopFollowing, useMultiExecStore, type JobView } from './store';
import { plural } from './strategy';

// Always mounted (the multi-exec action's background companion): follows the
// jobs left running by an earlier window of the app, and tells the user when
// a job ends or waits for approval while it is not on screen.

type Seen = { status: MultiExecJobStatus; pause: MultiExecPauseReason | null };

const STARTUP_DELAY_MS = 1500;

const short = (command: string) => {
    const line = command.split('\n')[0];
    return line.length > 60 ? `${line.slice(0, 57)}…` : line;
};

export function JobNotifier() {
    const toast = useToast();

    useEffect(() => {
        const seen = new Map<string, Seen>();
        const announce = (view: JobView) => {
            const { info } = view;
            const before = seen.get(info.id);
            const now: Seen = { status: info.status, pause: info.pause?.reason ?? null };
            seen.set(info.id, now);
            // First sight (or a finished job opened from the history): nothing to tell.
            if (!before || isJobFinal(before.status)) return;
            if (useMultiExecStore.getState().visibleJobId === info.id) return;
            const counts = countStatuses(view.servers.map((server) => server.status));
            const failed = counts.failed + counts.timeout;
            const command = short(info.command);
            if (isJobFinal(info.status)) {
                if (info.status === 'done' && failed === 0) toast.success(plural(t, 'multiexec.notify.done', counts.ok), command);
                else if (info.status === 'done') toast.warning(t('multiexec.notify.doneWithFailures', { ok: counts.ok, failed }), command);
                else if (info.status === 'stopped') toast.error(t(`multiexec.notify.stopped.${info.stopReason ?? 'failure-limit'}`, { failed }), command);
                else if (info.status === 'cancelled') toast.info(t('multiexec.notify.cancelled'), command);
                else toast.warning(t('multiexec.notify.interrupted'), command);
            } else if (now.pause && now.pause !== before.pause && now.pause !== 'user') {
                if (now.pause === 'canary') toast.info(t('multiexec.notify.canaryOk'), command);
                else toast.warning(t('multiexec.notify.canaryFailed'), command);
            }
        };
        const unsubscribe = useMultiExecStore.subscribe((state, previous) => {
            if (state.jobs === previous.jobs) return;
            for (const view of Object.values(state.jobs)) {
                if (previous.jobs[view.info.id] !== view || !seen.has(view.info.id)) announce(view);
            }
        });
        // Jobs still running from before (another window, a reload) are
        // followed, once the app has loaded what it needs first.
        const timer = window.setTimeout(() => void useMultiExecStore.getState().refreshList(), STARTUP_DELAY_MS);
        return () => {
            window.clearTimeout(timer);
            unsubscribe();
            stopFollowing();
        };
    }, [toast]);

    return null;
}
