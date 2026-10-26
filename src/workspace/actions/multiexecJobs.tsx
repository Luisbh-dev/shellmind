import { lazyWithRetry } from '@/lib/lazy';
import { History } from 'lucide-react';
import type { GlobalAction, GlobalActionProps } from './types';

const MultiExecModal = lazyWithRetry(() => import('@/features/multiexec/MultiExecModal'));

// The multi-exec dialog on its job list (running and finished jobs).
function MultiExecJobs(props: GlobalActionProps) {
    return <MultiExecModal {...props} initialView="jobs" />;
}

const multiExecJobsAction: GlobalAction = {
    id: 'multiexec-jobs',
    order: 41,
    labelKey: 'multiexec.jobsAction',
    icon: History,
    placement: 'palette',
    Component: MultiExecJobs
};

export default multiExecJobsAction;
