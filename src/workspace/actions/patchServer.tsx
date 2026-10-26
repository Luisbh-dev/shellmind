import { useEffect, useRef } from 'react';
import { PackageSearch } from 'lucide-react';
import { openPatchCenter } from '@/features/patch/public';
import type { GlobalAction, GlobalActionProps } from './types';

// W8-T3: the active server's updates in the patch center, from the command
// palette (whatever tab is on screen: Status, the terminal...). Runs once:
// it hands over to the patch center.
function PatchServer({ onClose, server }: GlobalActionProps) {
    const done = useRef(false);
    useEffect(() => {
        if (done.current) return;
        done.current = true;
        onClose();
        if (server) openPatchCenter(server.id);
    }, [server, onClose]);
    return null;
}

const patchServerAction: GlobalAction = {
    id: 'patch-server',
    order: 26,
    labelKey: 'patch.serverAction',
    icon: PackageSearch,
    placement: 'palette',
    requiresServer: true,
    // SSH servers, like the Operations tab.
    isAvailable: (server) => server !== null && ['linux', 'windows'].includes(server.type),
    Component: PatchServer
};

export default patchServerAction;
