import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { WorkspaceServer } from '../types';

export interface GlobalActionProps {
    onClose: () => void;
    // The active connection, if any.
    server: WorkspaceServer | null;
}

// An app-wide action (snippets, tunnels, command palette...). Each .tsx file in
// this folder default-exports one descriptor and is picked up by the registry;
// its Component renders the whole surface (modal, drawer) while it is open.
export interface GlobalAction {
    id: string;
    // Position among the header buttons and in the palette (ascending).
    order: number;
    // i18n key of the label (button tooltip, palette entry).
    labelKey: string;
    icon: LucideIcon;
    // Keyboard shortcut such as "Mod+K" or "Mod+Shift+P"; Mod is Ctrl, or Cmd on macOS.
    shortcut?: string;
    // 'header': a button in the workspace header (and a palette entry);
    // 'palette': only reachable from the command palette and its shortcut.
    placement: 'header' | 'palette';
    // Extra words the palette search matches, in every UI language (never shown).
    keywords?: string;
    // Hidden while no connection is selected.
    requiresServer?: boolean;
    isAvailable?: (server: WorkspaceServer | null) => boolean;
    Component: ComponentType<GlobalActionProps>;
    // W7-S4: always mounted next to the app, whether or not the action is
    // open (background watchers that notify, like multi-exec's finished jobs).
    // Renders nothing of its own; keep it light (it loads with the app).
    Background?: ComponentType;
}
