// The split layout of a server's terminal: a binary tree whose leaves are
// panes, each showing one of the server's terminal tabs (or none). Tabs stay
// sessions; panes are where they are on screen. A tab not shown in any pane
// keeps running in the background, as an unfocused tab always did.
//
// Pure functions: unchanged parts keep their identity, so a store holding a
// layout can tell when nothing changed.

// 'row': side by side (a vertical divider); 'column': one above the other.
export type SplitDirection = 'row' | 'column';
export type PaneLeaf = { type: 'pane'; id: string; sessionId: string | null };
export type PaneSplit = { type: 'split'; id: string; direction: SplitDirection; ratio: number; first: PaneNode; second: PaneNode };
export type PaneNode = PaneLeaf | PaneSplit;

// `activePaneId`: the pane of the server's focused tab, or the one a tab
// gets the focus in when it is not shown yet.
export type PaneLayout = { root: PaneNode; activePaneId: string };

// Fractions of the terminal area (0..1).
export type Rect = { x: number; y: number; w: number; h: number };
export type FocusDirection = 'left' | 'right' | 'up' | 'down';
// Where a tab dropped on a pane goes: one of its sides (a new pane there).
export type DropEdge = 'left' | 'right' | 'top' | 'bottom';

export const MAX_PANES = 4;
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;
// Keyboard steps of a divider (arrow keys, Mod+Alt+Shift+arrows).
export const RATIO_STEP = 0.05;

const EPSILON = 1e-6;

const clampRatio = (ratio: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, Number.isFinite(ratio) ? ratio : 0.5));

export function leaves(node: PaneNode): PaneLeaf[] {
    return node.type === 'pane' ? [node] : [...leaves(node.first), ...leaves(node.second)];
}

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | undefined {
    return leaves(node).find((leaf) => leaf.id === paneId);
}

export function leafOfSession(node: PaneNode, sessionId: string): PaneLeaf | undefined {
    return leaves(node).find((leaf) => leaf.sessionId === sessionId);
}

export function singlePane(paneId: string, sessionId: string | null): PaneLayout {
    return { root: { type: 'pane', id: paneId, sessionId }, activePaneId: paneId };
}

// `node` with each leaf replaced by `update(leaf)`; unchanged subtrees are
// returned as they were.
function mapLeaves(node: PaneNode, update: (leaf: PaneLeaf) => PaneNode): PaneNode {
    if (node.type === 'pane') return update(node);
    const first = mapLeaves(node.first, update);
    const second = mapLeaves(node.second, update);
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

function mapSplits(node: PaneNode, update: (split: PaneSplit) => PaneSplit): PaneNode {
    if (node.type === 'pane') return node;
    const first = mapSplits(node.first, update);
    const second = mapSplits(node.second, update);
    return update(first === node.first && second === node.second ? node : { ...node, first, second });
}

// The pane `paneId` shows `sessionId` (no swap: see showSession).
export function setLeafSession(node: PaneNode, paneId: string, sessionId: string | null): PaneNode {
    return mapLeaves(node, (leaf) => (leaf.id === paneId && leaf.sessionId !== sessionId ? { ...leaf, sessionId } : leaf));
}

// `added` next to the pane `paneId` (after it: right of it or below it),
// the two sharing its space equally. Unchanged at MAX_PANES.
export function splitPane(
    root: PaneNode,
    paneId: string,
    direction: SplitDirection,
    added: PaneLeaf,
    splitId: string,
    place: 'before' | 'after' = 'after'
): PaneNode {
    if (leaves(root).length >= MAX_PANES || !findLeaf(root, paneId)) return root;
    return mapLeaves(root, (leaf) => {
        if (leaf.id !== paneId) return leaf;
        const [first, second] = place === 'after' ? [leaf, added] : [added, leaf];
        return { type: 'split', id: splitId, direction, ratio: 0.5, first, second };
    });
}

// The layout without the pane `paneId`: the other side of its split takes
// its space. `takeover`: the pane next to it that grew (the one the focus
// moves to). The only pane cannot be removed.
export function removePane(root: PaneNode, paneId: string): { root: PaneNode; takeover: PaneLeaf | null } {
    if (root.type === 'pane') return { root, takeover: null };
    let takeover: PaneLeaf | null = null;
    const remove = (node: PaneNode): PaneNode => {
        if (node.type === 'pane') return node;
        if (node.first.type === 'pane' && node.first.id === paneId) {
            takeover = leaves(node.second)[0];
            return node.second;
        }
        if (node.second.type === 'pane' && node.second.id === paneId) {
            const remaining = leaves(node.first);
            takeover = remaining[remaining.length - 1];
            return node.first;
        }
        const first = remove(node.first);
        const second = remove(node.second);
        return first === node.first && second === node.second ? node : { ...node, first, second };
    };
    const next = remove(root);
    return { root: next, takeover };
}

// The pane `paneId` shows `sessionId`. When another pane showed it, the two
// swap: that pane shows what this one showed.
export function showSession(root: PaneNode, paneId: string, sessionId: string): PaneNode {
    const target = findLeaf(root, paneId);
    if (!target || target.sessionId === sessionId) return root;
    const other = leafOfSession(root, sessionId);
    return mapLeaves(root, (leaf) => {
        if (leaf.id === paneId) return { ...leaf, sessionId };
        if (other && leaf.id === other.id) return { ...leaf, sessionId: target.sessionId };
        return leaf;
    });
}

export function resizeSplit(root: PaneNode, splitId: string, ratio: number): PaneNode {
    const value = clampRatio(ratio);
    return mapSplits(root, (split) => (split.id === splitId && split.ratio !== value ? { ...split, ratio: value } : split));
}

export function findSplit(root: PaneNode, splitId: string): PaneSplit | undefined {
    if (root.type === 'pane') return undefined;
    if (root.id === splitId) return root;
    return findSplit(root.first, splitId) ?? findSplit(root.second, splitId);
}

// The split a drop on `edge` makes.
function edgeSplit(edge: DropEdge): { direction: SplitDirection; place: 'before' | 'after' } {
    return {
        direction: edge === 'left' || edge === 'right' ? 'row' : 'column',
        place: edge === 'left' || edge === 'top' ? 'before' : 'after'
    };
}

// `sessionId` in a new pane on `edge` of the pane `targetId`. A tab already
// shown in another pane leaves it (that pane closes), so the number of panes
// only grows for a tab that was not on screen. Unchanged when it cannot be
// done (its own pane, or MAX_PANES reached).
export function moveSessionToEdge(
    root: PaneNode,
    sessionId: string,
    targetId: string,
    edge: DropEdge,
    ids: { paneId: string; splitId: string }
): PaneNode {
    const source = leafOfSession(root, sessionId);
    if (!findLeaf(root, targetId) || source?.id === targetId) return root;
    const base = source ? removePane(root, source.id).root : root;
    if (leaves(base).length >= MAX_PANES) return root;
    const { direction, place } = edgeSplit(edge);
    return splitPane(base, targetId, direction, { type: 'pane', id: ids.paneId, sessionId }, ids.splitId, place);
}

// ---- Geometry ----------------------------------------------------------------

function collectRects(node: PaneNode, rect: Rect, panes: Map<string, Rect>, splits: Array<{ split: PaneSplit; rect: Rect }>): void {
    if (node.type === 'pane') {
        panes.set(node.id, rect);
        return;
    }
    splits.push({ split: node, rect });
    if (node.direction === 'row') {
        const width = rect.w * node.ratio;
        collectRects(node.first, { ...rect, w: width }, panes, splits);
        collectRects(node.second, { ...rect, x: rect.x + width, w: rect.w - width }, panes, splits);
    } else {
        const height = rect.h * node.ratio;
        collectRects(node.first, { ...rect, h: height }, panes, splits);
        collectRects(node.second, { ...rect, y: rect.y + height, h: rect.h - height }, panes, splits);
    }
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

export function paneRects(root: PaneNode): Map<string, Rect> {
    const panes = new Map<string, Rect>();
    collectRects(root, FULL, panes, []);
    return panes;
}

// Every split with the area it divides (its divider sits at `ratio` of it).
export function splitRects(root: PaneNode): Array<{ split: PaneSplit; rect: Rect }> {
    const splits: Array<{ split: PaneSplit; rect: Rect }> = [];
    collectRects(root, FULL, new Map(), splits);
    return splits;
}

const overlap = (startA: number, endA: number, startB: number, endB: number) => Math.min(endA, endB) - Math.max(startA, startB);

// The pane next to `paneId` in `direction`: among the panes on that side
// that share some of its height (or width), the nearest, then the one
// sharing the most, then the first (top, left). Null at the edge.
export function neighbourPane(root: PaneNode, paneId: string, direction: FocusDirection): PaneLeaf | null {
    const rects = paneRects(root);
    const from = rects.get(paneId);
    if (!from) return null;
    let best: { leaf: PaneLeaf; distance: number; shared: number } | null = null;
    for (const leaf of leaves(root)) {
        const rect = rects.get(leaf.id);
        if (!rect || leaf.id === paneId) continue;
        let distance: number;
        let shared: number;
        if (direction === 'left' || direction === 'right') {
            shared = overlap(from.y, from.y + from.h, rect.y, rect.y + rect.h);
            distance = direction === 'right' ? rect.x - (from.x + from.w) : from.x - (rect.x + rect.w);
        } else {
            shared = overlap(from.x, from.x + from.w, rect.x, rect.x + rect.w);
            distance = direction === 'down' ? rect.y - (from.y + from.h) : from.y - (rect.y + rect.h);
        }
        if (shared <= EPSILON || distance < -EPSILON) continue;
        const better = !best
            || distance < best.distance - EPSILON
            || (Math.abs(distance - best.distance) <= EPSILON && shared > best.shared + EPSILON);
        if (better) best = { leaf, distance, shared };
    }
    return best?.leaf ?? null;
}

// The innermost split around `paneId` that divides along `direction`
// ('row' for left/right): the divider the keyboard moves for that pane.
export function nearestSplit(root: PaneNode, paneId: string, direction: SplitDirection): PaneSplit | null {
    const path = (node: PaneNode): PaneSplit[] | null => {
        if (node.type === 'pane') return node.id === paneId ? [] : null;
        const inner = path(node.first) ?? path(node.second);
        return inner ? [node, ...inner] : null;
    };
    const splits = path(root) ?? [];
    for (let index = splits.length - 1; index >= 0; index--) {
        if (splits[index].direction === direction) return splits[index];
    }
    return null;
}

// ---- Reconciling with the tabs ------------------------------------------------

// The layout once the server's tabs are `sessionIds` and `focusedId` has
// the focus: a pane whose tab was closed goes (the last pane stays, empty);
// the focused tab shows in the active pane if no pane shows it yet, and the
// pane showing it becomes the active one. `focus`: the tab the focus should
// move to instead, when the active pane closed with its tab and the focus
// went to a tab not on screen (the pane that took its place keeps its own).
export function reconcile(layout: PaneLayout, sessionIds: readonly string[], focusedId: string | null): { layout: PaneLayout; focus: string | null } {
    const alive = new Set(sessionIds);
    const seen = new Set<string>();
    let root = layout.root;
    let active = layout.activePaneId;
    let activeClosed = false;

    for (const leaf of leaves(layout.root)) {
        if (leaf.sessionId === null) continue;
        const gone = !alive.has(leaf.sessionId) || seen.has(leaf.sessionId);
        seen.add(leaf.sessionId);
        if (!gone) continue;
        if (leaves(root).length > 1) {
            const removed = removePane(root, leaf.id);
            root = removed.root;
            if (leaf.id === active && removed.takeover) {
                active = removed.takeover.id;
                activeClosed = true;
            }
        } else {
            root = setLeafSession(root, leaf.id, null);
        }
    }
    if (!findLeaf(root, active)) active = leaves(root)[0].id;

    let focus: string | null = null;
    if (focusedId !== null && alive.has(focusedId)) {
        const showing = leafOfSession(root, focusedId);
        const activeSession = findLeaf(root, active)?.sessionId ?? null;
        if (showing) active = showing.id;
        else if (activeClosed && activeSession !== null) focus = activeSession;
        else root = showSession(root, active, focusedId);
    }

    const unchanged = root === layout.root && active === layout.activePaneId;
    return { layout: unchanged ? layout : { root, activePaneId: active }, focus };
}

// ---- Remembered shape ----------------------------------------------------------

// A layout without its panes' tabs and ids: what is remembered per server.
export type PaneShape = { type: 'pane' } | { type: 'split'; direction: SplitDirection; ratio: number; first: PaneShape; second: PaneShape };

export function shapeOf(node: PaneNode): PaneShape {
    if (node.type === 'pane') return { type: 'pane' };
    return { type: 'split', direction: node.direction, ratio: node.ratio, first: shapeOf(node.first), second: shapeOf(node.second) };
}

export function shapePanes(shape: PaneShape): number {
    return shape.type === 'pane' ? 1 : shapePanes(shape.first) + shapePanes(shape.second);
}

// A stored shape, or null when it is not one (or has more than MAX_PANES).
export function parseShape(value: unknown): PaneShape | null {
    const parse = (item: unknown, depth: number): PaneShape | null => {
        if (!item || typeof item !== 'object' || depth > MAX_PANES) return null;
        const node = item as Record<string, unknown>;
        if (node.type === 'pane') return { type: 'pane' };
        if (node.type !== 'split' || (node.direction !== 'row' && node.direction !== 'column') || typeof node.ratio !== 'number') return null;
        const first = parse(node.first, depth + 1);
        const second = parse(node.second, depth + 1);
        if (!first || !second) return null;
        return { type: 'split', direction: node.direction, ratio: clampRatio(node.ratio), first, second };
    };
    const shape = parse(value, 0);
    return shape && shapePanes(shape) <= MAX_PANES ? shape : null;
}

// Empty panes in `shape`, with ids from `nextId`.
export function fromShape(shape: PaneShape, nextId: (kind: 'pane' | 'split') => string): PaneNode {
    if (shape.type === 'pane') return { type: 'pane', id: nextId('pane'), sessionId: null };
    return {
        type: 'split',
        id: nextId('split'),
        direction: shape.direction,
        ratio: shape.ratio,
        first: fromShape(shape.first, nextId),
        second: fromShape(shape.second, nextId)
    };
}
