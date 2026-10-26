import { lazyWithRetry } from '@/lib/lazy';
import { Network } from 'lucide-react';
import { JobNotifier } from '@/features/multiexec/JobNotifier';
import type { GlobalAction } from './types';

const MultiExecModal = lazyWithRetry(() => import('@/features/multiexec/MultiExecModal'));

const multiExecAction: GlobalAction = {
    id: 'multiexec',
    order: 40,
    labelKey: 'multiexec.title',
    icon: Network,
    shortcut: 'Mod+Shift+E',
    placement: 'header',
    Component: MultiExecModal,
    // Follows the running jobs and says when one ends, with the dialog closed.
    Background: JobNotifier
};

export default multiExecAction;
