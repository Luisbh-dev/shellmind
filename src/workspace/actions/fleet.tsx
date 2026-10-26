import { lazyWithRetry } from '@/lib/lazy';
import { HeartPulse } from 'lucide-react';
import { FLEET_ACTION_ID } from '@/features/fleet/public';
import type { GlobalAction } from './types';

const FleetBoard = lazyWithRetry(() => import('@/features/fleet/FleetBoard'));

// W7-S1: the health of every SSH server on one screen.
const fleetAction: GlobalAction = {
    id: FLEET_ACTION_ID,
    order: 20,
    labelKey: 'fleet.title',
    icon: HeartPulse,
    shortcut: 'Mod+Shift+H',
    placement: 'header',
    Component: FleetBoard
};

export default fleetAction;
