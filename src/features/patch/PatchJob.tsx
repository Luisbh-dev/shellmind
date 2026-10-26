import { useEffect, useMemo, useState } from 'react';
import { Spinner, useToast } from '@/components/ui';
import { useT } from '@/i18n';
import { controlErrorText, JobView, useMultiExecStore } from '@/features/multiexec/public';
import { localizePatchRuns } from './output';

// A patch run, shown with multi-exec's job view (it is a multi-exec job):
// progress by batch, the canary's approval, pause, resume and cancel, and
// every server's output, with what ShellMind says in it in the user's
// language.
export function PatchJob({ jobId, onOpenJob }: { jobId: string; onOpenJob?: (id: string) => void }) {
    const t = useT();
    const toast = useToast();
    const raw = useMultiExecStore((state) => state.jobs[jobId]);
    const view = useMemo(() => (raw ? { ...raw, servers: localizePatchRuns(raw.servers, t) } : raw), [raw, t]);
    const [busy, setBusy] = useState<'pause' | 'resume' | 'cancel' | null>(null);

    // Followed while it is on screen, and spared the "job finished" toast.
    useEffect(() => {
        const store = useMultiExecStore.getState();
        store.follow(jobId);
        store.setVisibleJob(jobId);
        return () => {
            if (useMultiExecStore.getState().visibleJobId === jobId) useMultiExecStore.getState().setVisibleJob(null);
        };
    }, [jobId]);

    const control = async (action: 'pause' | 'resume' | 'cancel') => {
        setBusy(action);
        try {
            await useMultiExecStore.getState()[action](jobId);
        } catch (error) {
            toast.error(t(`multiexec.errors.${action}Failed`), controlErrorText(error, t));
        } finally {
            setBusy(null);
        }
    };

    if (!view) {
        return (
            <div className="flex flex-1 items-center justify-center py-8 text-zinc-400" role="status">
                <Spinner /><span className="sr-only">{t('multiexec.loading')}</span>
            </div>
        );
    }
    return (
        <JobView
            view={view}
            busy={busy}
            onPause={() => void control('pause')}
            onResume={() => void control('resume')}
            onCancel={() => void control('cancel')}
            onOpenJob={(id) => onOpenJob?.(id)}
        />
    );
}
