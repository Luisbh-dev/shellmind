import { lazyWithRetry } from '@/lib/lazy';
import { PackageCheck } from 'lucide-react';
import { PATCH_ACTION_ID } from '@/features/patch/public';
import type { GlobalAction } from './types';

const PatchCenter = lazyWithRetry(() => import('@/features/patch/PatchCenter'));

// W8-T3: pending and security updates and pending reboots of every SSH
// server, and patch runs (multi-exec jobs) on the ones picked.
const patchCenterAction: GlobalAction = {
    id: PATCH_ACTION_ID,
    order: 25,
    labelKey: 'patch.action',
    icon: PackageCheck,
    placement: 'header',
    Component: PatchCenter
};

export default patchCenterAction;
