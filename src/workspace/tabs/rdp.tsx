import { lazyWithRetry } from '@/lib/lazy';
import { Monitor } from 'lucide-react';
import type { WorkspaceTab } from '../types';

// The panel loads with the tab; the RDP client itself (WebAssembly, ~6 MB)
// only with the first connection.
const RdpPanel = lazyWithRetry(() => import('@/features/rdp/RdpPanel'));

const rdpTab: WorkspaceTab = {
    id: 'rdp',
    order: 40,
    labelKey: 'app.tabs.rdp',
    icon: Monitor,
    isAvailable: (server) => server.type === 'windows',
    // A Windows server opens on its desktop (the embedded client).
    isPreferredFor: (server) => server.type === 'windows',
    // Keyed by server: a session, an error or a launch never shows for another one.
    Component: ({ server, isActive }) => <RdpPanel key={server.id} server={server} isActive={isActive} />
};

export default rdpTab;
