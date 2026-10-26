import { lazyWithRetry } from '@/lib/lazy';
import { KeyRound } from 'lucide-react';
import { KNOWN_HOSTS_ACTION_ID } from '@/features/knownHosts/HostKeyCard';
import type { GlobalAction } from './types';

const KnownHostsDialog = lazyWithRetry(async () => ({ default: (await import('@/features/knownHosts/KnownHostsDialog')).KnownHostsDialog }));

// Every pinned SSH host key, from the command palette (and the Tunnels tab).
const knownHostsAction: GlobalAction = {
    id: KNOWN_HOSTS_ACTION_ID,
    order: 85,
    labelKey: 'knownHosts.action',
    icon: KeyRound,
    placement: 'palette',
    Component: KnownHostsDialog
};

export default knownHostsAction;
