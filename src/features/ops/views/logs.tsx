import { ScrollText } from 'lucide-react';
import { LogsView } from '../LogsView';
import type { OpsView } from '../viewTypes';

// Live logs: the journal, a file, a container or a Compose project.
const logsView: OpsView = {
    id: 'logs',
    order: 90,
    labelKey: 'ops.views.logs',
    icon: ScrollText,
    Component: ({ server, caps, logRequest }) => <LogsView serverId={server.id} serverName={server.name} caps={caps} request={logRequest} />
};

export default logsView;
