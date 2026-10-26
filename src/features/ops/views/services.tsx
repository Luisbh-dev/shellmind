import { Cog } from 'lucide-react';
import { ServicesView } from '../ServicesView';
import type { OpsView } from '../viewTypes';

// systemd units or Windows services (an empty state explains a server without either).
const servicesView: OpsView = {
    id: 'services',
    order: 10,
    labelKey: 'ops.views.services',
    icon: Cog,
    Component: ({ server, caps, followLogs }) => <ServicesView serverId={server.id} caps={caps} onFollowLogs={followLogs} />
};

export default servicesView;
