import type { OpsCapabilities } from '@shared/ops';
import type { OpsView } from './viewTypes';

const modules = import.meta.glob<OpsView>('./views/*.tsx', { eager: true, import: 'default' });

export const opsViews: readonly OpsView[] = Object.values(modules).sort((a, b) => a.order - b.order);

// While the capabilities load every view is listed; then the ones the server
// cannot offer go.
export function availableViews(caps: OpsCapabilities | null): OpsView[] {
    return opsViews.filter((view) => !caps || !view.isAvailable || view.isAvailable(caps));
}
