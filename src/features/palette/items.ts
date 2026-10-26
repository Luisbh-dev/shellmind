import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { fuzzyMatch } from './fuzzy';

// What the command palette lists. The app shell builds the items (servers,
// tabs of the active server, global actions, app commands).

export type PaletteSection = 'servers' | 'tabs' | 'actions' | 'commands';
export const PALETTE_SECTIONS: readonly PaletteSection[] = ['servers', 'tabs', 'actions', 'commands'];

export interface PaletteItem {
    id: string;
    section: PaletteSection;
    label: string;
    // Secondary text in the code font (a server's user@address).
    detail?: string;
    // The option in effect (the current theme or language): a check mark.
    current?: boolean;
    // Extra words the search matches (user, tags, group...), never shown.
    keywords?: string;
    icon: LucideIcon;
    // Drawn instead of `icon` (a server's OS mark).
    iconNode?: ReactNode;
    // Display form, e.g. "Ctrl+K".
    shortcut?: string;
    run: () => void;
}

export type RankedItem = { item: PaletteItem; positions: number[] };

// Without a query: the given order, at most `perSection` items per section.
// With a query: matching items, best first (label matches beat keyword-only
// matches), sections only as a tie-breaker.
export function rankItems(items: PaletteItem[], query: string, perSection = 8): RankedItem[] {
    if (!query.trim()) {
        const counts = new Map<PaletteSection, number>();
        return items.filter((item) => {
            const count = counts.get(item.section) ?? 0;
            counts.set(item.section, count + 1);
            return count < perSection;
        }).map((item) => ({ item, positions: [] }));
    }

    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const ranked: Array<RankedItem & { score: number; order: number }> = [];
    items.forEach((item, order) => {
        const label = fuzzyMatch(query, item.label);
        if (label) {
            ranked.push({ item, positions: label.positions, score: label.score + 20, order });
            return;
        }
        // Details and keywords (address, user, tags) only match literally.
        const haystack = [item.label, item.detail, item.keywords].filter(Boolean).join(' ').toLowerCase();
        if (words.every((word) => haystack.includes(word))) ranked.push({ item, positions: [], score: 5 * words.length, order });
    });
    return ranked
        .sort((a, b) => b.score - a.score
            || PALETTE_SECTIONS.indexOf(a.item.section) - PALETTE_SECTIONS.indexOf(b.item.section)
            || a.order - b.order)
        .map(({ item, positions }) => ({ item, positions }));
}
