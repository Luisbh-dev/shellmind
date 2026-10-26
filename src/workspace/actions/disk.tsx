import { HardDrive } from 'lucide-react';
import { lazyWithRetry } from '@/lib/lazy';
import { DISK_ACTION_ID, supportsDiskToolkit } from '@/store/diskView';
import type { GlobalAction } from './types';

const DiskToolkit = lazyWithRetry(() => import('@/features/disk/DiskToolkit'));

// W8-T4: the disk-full toolkit of the active server, from the palette (the
// Status page opens it on a filesystem).
const diskAction: GlobalAction = {
    id: DISK_ACTION_ID,
    order: 75,
    labelKey: 'disk.action',
    icon: HardDrive,
    placement: 'palette',
    requiresServer: true,
    isAvailable: supportsDiskToolkit,
    Component: DiskToolkit
};

export default diskAction;
