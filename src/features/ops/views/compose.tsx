import { Boxes } from 'lucide-react';
import { ComposeView } from '../ComposeView';
import type { OpsView } from '../viewTypes';

// Compose projects of a Linux server with a container engine.
const composeView: OpsView = {
    id: 'compose',
    order: 30,
    labelKey: 'ops.views.compose',
    icon: Boxes,
    isAvailable: (caps) => caps.platform === 'linux' && caps.containers.engine !== null,
    Component: ({ server, caps, followLogs }) => <ComposeView serverId={server.id} caps={caps} onFollowLogs={followLogs} />
};

export default composeView;
