import { Container } from 'lucide-react';
import { ContainersView } from '../ContainersView';
import type { OpsView } from '../viewTypes';

// Docker or Podman containers (an empty state says why there is no engine).
const containersView: OpsView = {
    id: 'containers',
    order: 20,
    labelKey: 'ops.views.containers',
    icon: Container,
    Component: ({ server, caps, followLogs }) => <ContainersView serverId={server.id} caps={caps} onFollowLogs={followLogs} />
};

export default containersView;
