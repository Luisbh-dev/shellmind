import { lazyWithRetry } from '@/lib/lazy';
import { Activity } from 'lucide-react';
import type { WorkspaceTab } from '../types';

const StatusDashboard = lazyWithRetry(() => import('@/features/status/StatusDashboard'));

const statusTab: WorkspaceTab = {
    id: 'status',
    order: 30,
    labelKey: 'app.tabs.status',
    icon: Activity,
    // SSH-capable hosts only (rows without a known type are treated as SSH).
    isAvailable: (server) => !['ftp', 's3', 'local'].includes(server.type),
    Component: ({ server, isActive }) => <StatusDashboard server={server} isActive={isActive} />
};

export default statusTab;
