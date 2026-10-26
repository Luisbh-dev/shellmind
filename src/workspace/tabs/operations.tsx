import { lazyWithRetry } from '@/lib/lazy';
import { Wrench } from 'lucide-react';
import type { WorkspaceTab } from '../types';

const OperationsPanel = lazyWithRetry(() => import('@/features/ops/OperationsPanel'));

// Services, containers and live logs of an SSH server.
const operationsTab: WorkspaceTab = {
    id: 'operations',
    order: 35,
    labelKey: 'ops.tab',
    icon: Wrench,
    // SSH-capable hosts only, like the status tab.
    isAvailable: (server) => !['ftp', 's3', 'local'].includes(server.type),
    Component: ({ server, isActive }) => <OperationsPanel server={server} isActive={isActive} />
};

export default operationsTab;
