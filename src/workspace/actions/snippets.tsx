import { lazyWithRetry } from '@/lib/lazy';
import { BookMarked } from 'lucide-react';
import type { GlobalAction } from './types';

const SnippetsModal = lazyWithRetry(() => import('@/features/snippets/SnippetsModal'));

const snippetsAction: GlobalAction = {
    id: 'snippets',
    order: 30,
    labelKey: 'snippets.title',
    icon: BookMarked,
    shortcut: 'Mod+Shift+S',
    placement: 'header',
    Component: SnippetsModal
};

export default snippetsAction;
