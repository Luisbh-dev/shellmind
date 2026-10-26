import { lazyWithRetry } from '@/lib/lazy';
import { Cable } from 'lucide-react';
import { supportsTunnels } from '@shared/tunnels';
import type { WorkspaceTab } from '../types';

const TunnelsPanel = lazyWithRetry(() => import('@/features/tunnels/TunnelsPanel'));

const tunnelsTab: WorkspaceTab = {
    id: 'tunnels',
    order: 50,
    labelKey: 'tunnels.tab',
    icon: Cable,
    // Local port forwarding runs over SSH.
    isAvailable: (server) => supportsTunnels(server.type),
    Component: ({ server, isActive }) => <TunnelsPanel server={server} isActive={isActive} />
};

export default tunnelsTab;
