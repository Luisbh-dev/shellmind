import { Suspense } from 'react';
import { PackageCheck } from 'lucide-react';
import { Spinner } from '@/components/ui';
import { lazyWithRetry } from '@/lib/lazy';
import { openPatchCenter } from '@/features/patch/public';
import type { OpsView } from '../viewTypes';

const ServerUpdates = lazyWithRetry(() => import('@/features/patch/ServerUpdates'));

// W8-T3: the server's pending updates, security updates and pending reboot,
// with scan, refresh and install (the patch center, for this server).
const updatesView: OpsView = {
    id: 'updates',
    order: 50,
    labelKey: 'patch.view',
    icon: PackageCheck,
    Component: ({ server }) => (
        <Suspense fallback={<div className="flex justify-center p-6 text-zinc-400"><Spinner /></div>}>
            <ServerUpdates server={server} layout="tab" onOpenCenter={() => openPatchCenter(server.id)} />
        </Suspense>
    )
};

export default updatesView;
