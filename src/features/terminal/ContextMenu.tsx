import { ClipboardPaste, Copy, Eraser, MousePointerClick, PanelTop, Search, TextSelect } from 'lucide-react';
import { ContextMenu as MenuAtPoint } from '@/components/ui/ContextMenu';
import type { MenuItem } from '@/components/ui/Menu';
import { useT } from '@/i18n';

export type ContextMenuAction = 'copy' | 'paste' | 'select-all' | 'search' | 'ask-ai' | 'clear' | 'focus-toolbar';

// The terminal's context menu: right click, Shift+F10 or the Menu key. It is
// the app's menu primitive, so it joins the overlay stack (Escape closes it
// first, global shortcuts wait while it is open).
export function ContextMenu({
    x,
    y,
    hasSelection,
    shortcuts,
    onAction,
    onClose
}: {
    x: number;
    y: number;
    hasSelection: boolean;
    shortcuts: { copy: string; paste: string; search: string };
    onAction: (action: ContextMenuAction) => void;
    onClose: () => void;
}) {
    const t = useT();
    const item = (id: ContextMenuAction, label: string, icon: React.ReactNode, extra: Partial<MenuItem> = {}): MenuItem => ({
        id, label, icon, onSelect: () => onAction(id), ...extra
    });
    const items: Array<MenuItem | 'separator'> = [
        item('copy', t('terminal.menu.copy'), <Copy className="h-4 w-4" />, { hint: shortcuts.copy, disabled: !hasSelection }),
        item('paste', t('terminal.menu.paste'), <ClipboardPaste className="h-4 w-4" />, { hint: shortcuts.paste }),
        item('select-all', t('terminal.menu.selectAll'), <TextSelect className="h-4 w-4" />),
        item('search', t('terminal.menu.search'), <Search className="h-4 w-4" />, { hint: shortcuts.search }),
        'separator',
        item('ask-ai', t('terminal.menu.askAi'), <MousePointerClick className="h-4 w-4" />),
        item('clear', t('terminal.menu.clear'), <Eraser className="h-4 w-4" />),
        item('focus-toolbar', t('terminal.menu.focusToolbar'), <PanelTop className="h-4 w-4" />, { hint: 'Alt+F10' })
    ];
    return <MenuAtPoint x={x} y={y} label={t('terminal.menu.label')} items={items} onClose={onClose} />;
}
