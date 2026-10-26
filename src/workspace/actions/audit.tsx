import { lazyWithRetry } from '@/lib/lazy';
import { ScrollText } from 'lucide-react';
import type { GlobalAction } from './types';

const AuditModal = lazyWithRetry(() => import('@/features/audit/AuditModal'));

const auditAction: GlobalAction = {
    id: 'audit',
    order: 80,
    labelKey: 'audit.title',
    icon: ScrollText,
    shortcut: 'Mod+Shift+L',
    placement: 'palette',
    Component: AuditModal
};

export default auditAction;
