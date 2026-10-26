import { Layers } from 'lucide-react';
import { ImagesView } from '../ImagesView';
import type { OpsView } from '../viewTypes';

// Images and the engine's disk space, with previewed prunes.
const imagesView: OpsView = {
    id: 'images',
    order: 40,
    labelKey: 'ops.views.images',
    icon: Layers,
    isAvailable: (caps) => caps.platform === 'linux' && caps.containers.engine !== null,
    Component: ({ server, caps }) => <ImagesView serverId={server.id} caps={caps} />
};

export default imagesView;
