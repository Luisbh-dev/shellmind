import { describe, expect, it } from 'vitest';
import {
    MAX_PANES, fromShape, leafOfSession, leaves, moveSessionToEdge, nearestSplit, neighbourPane, paneRects, parseShape,
    reconcile, removePane, resizeSplit, shapeOf, shapePanes, showSession, singlePane, splitPane, splitRects,
    type PaneLeaf, type PaneNode
} from './layout';

const pane = (id: string, sessionId: string | null = id.replace('p', 's')): PaneLeaf => ({ type: 'pane', id, sessionId });

// p1 | (p2 / p3): one pane on the left, two stacked on the right.
function threePanes(): PaneNode {
    const two = splitPane(pane('p1'), 'p1', 'row', pane('p2'), 'x1');
    return splitPane(two, 'p2', 'column', pane('p3'), 'x2');
}

const sessionsOf = (root: PaneNode) => leaves(root).map((leaf) => leaf.sessionId);

describe('split layout', () => {
    it('splits a pane in two halves, before or after it, up to MAX_PANES', () => {
        const root = threePanes();
        expect(sessionsOf(root)).toEqual(['s1', 's2', 's3']);
        const rects = paneRects(root);
        expect(rects.get('p1')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
        expect(rects.get('p2')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
        expect(rects.get('p3')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });

        const before = splitPane(pane('p1'), 'p1', 'column', pane('p0'), 'x0', 'before');
        expect(sessionsOf(before)).toEqual(['s0', 's1']);

        const four = splitPane(root, 'p1', 'column', pane('p4'), 'x3');
        expect(leaves(four)).toHaveLength(MAX_PANES);
        expect(splitPane(four, 'p4', 'row', pane('p5'), 'x4')).toBe(four);
        expect(splitPane(root, 'nope', 'row', pane('p5'), 'x4')).toBe(root);
    });

    it('closes a pane: the other side of its split takes its place', () => {
        const root = threePanes();
        const { root: withoutLeft, takeover } = removePane(root, 'p1');
        expect(sessionsOf(withoutLeft)).toEqual(['s2', 's3']);
        expect(takeover?.id).toBe('p2');
        expect(paneRects(withoutLeft).get('p2')).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });

        const { root: withoutBottom, takeover: grew } = removePane(root, 'p3');
        expect(sessionsOf(withoutBottom)).toEqual(['s1', 's2']);
        expect(grew?.id).toBe('p2');

        const single = pane('p1');
        expect(removePane(single, 'p1')).toEqual({ root: single, takeover: null });
    });

    it('swaps tabs when a pane is asked to show a tab another pane shows', () => {
        const root = threePanes();
        const swapped = showSession(root, 'p1', 's3');
        expect(sessionsOf(swapped)).toEqual(['s3', 's2', 's1']);
        expect(sessionsOf(showSession(root, 'p2', 's9'))).toEqual(['s1', 's9', 's3']);
        expect(showSession(root, 'p1', 's1')).toBe(root);
    });

    it('resizes splits within bounds and keeps untouched subtrees', () => {
        const root = threePanes();
        const resized = resizeSplit(root, 'x1', 0.7);
        expect(paneRects(resized).get('p1')?.w).toBeCloseTo(0.7);
        expect(paneRects(resizeSplit(root, 'x1', 0.99)).get('p1')?.w).toBeCloseTo(0.85);
        expect(paneRects(resizeSplit(root, 'x1', -1)).get('p1')?.w).toBeCloseTo(0.15);
        expect(resizeSplit(root, 'x1', 0.5)).toBe(root);
        expect(splitRects(resized).map(({ split, rect }) => [split.id, rect])).toEqual([
            ['x1', { x: 0, y: 0, w: 1, h: 1 }],
            ['x2', { x: 0.7, y: 0, w: expect.closeTo(0.3), h: 1 }]
        ]);
    });

    it('finds the neighbour of a pane in each direction', () => {
        const root = threePanes();
        expect(neighbourPane(root, 'p1', 'right')?.id).toBe('p2');
        expect(neighbourPane(root, 'p1', 'left')).toBeNull();
        expect(neighbourPane(root, 'p3', 'left')?.id).toBe('p1');
        expect(neighbourPane(root, 'p3', 'up')?.id).toBe('p2');
        expect(neighbourPane(root, 'p2', 'down')?.id).toBe('p3');
        expect(neighbourPane(root, 'p2', 'up')).toBeNull();
        // The one sharing more of the edge wins.
        const lower = resizeSplit(root, 'x2', 0.3);
        expect(neighbourPane(lower, 'p1', 'right')?.id).toBe('p3');
    });

    it('finds the divider the keyboard moves for a pane', () => {
        const root = threePanes();
        expect(nearestSplit(root, 'p3', 'row')?.id).toBe('x1');
        expect(nearestSplit(root, 'p3', 'column')?.id).toBe('x2');
        expect(nearestSplit(root, 'p1', 'column')).toBeNull();
    });

    it('moves a tab to a side of a pane: a tab on screen leaves its pane, a hidden one adds a pane', () => {
        const root = threePanes();
        const ids = { paneId: 'p9', splitId: 'x9' };
        const moved = moveSessionToEdge(root, 's3', 'p1', 'top', ids);
        expect(leaves(moved).map((leaf) => leaf.sessionId)).toEqual(['s3', 's1', 's2']);
        expect(paneRects(moved).get('p9')).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });

        const added = moveSessionToEdge(root, 's7', 'p2', 'left', ids);
        expect(sessionsOf(added)).toEqual(['s1', 's7', 's2', 's3']);
        // Full: only a tab already on screen moves.
        expect(moveSessionToEdge(added, 's8', 'p1', 'right', { paneId: 'p10', splitId: 'x10' })).toBe(added);
        expect(sessionsOf(moveSessionToEdge(added, 's1', 'p3', 'right', { paneId: 'p10', splitId: 'x10' }))).toEqual(['s7', 's2', 's3', 's1']);
        // Not onto its own pane.
        expect(moveSessionToEdge(root, 's1', 'p1', 'left', ids)).toBe(root);
    });
});

describe('reconcile', () => {
    const layout = (root: PaneNode, activePaneId: string) => ({ root, activePaneId });

    it('shows the focused tab in the active pane when no pane shows it', () => {
        const start = layout(threePanes(), 'p2');
        const { layout: next, focus } = reconcile(start, ['s1', 's2', 's3', 's4'], 's4');
        expect(sessionsOf(next.root)).toEqual(['s1', 's4', 's3']);
        expect(next.activePaneId).toBe('p2');
        expect(focus).toBeNull();
    });

    it('makes the pane of the focused tab the active one, and changes nothing else', () => {
        const start = layout(threePanes(), 'p2');
        const { layout: next } = reconcile(start, ['s1', 's2', 's3'], 's3');
        expect(next.activePaneId).toBe('p3');
        expect(next.root).toBe(start.root);
        expect(reconcile(next, ['s1', 's2', 's3'], 's3').layout).toBe(next);
    });

    it('closes the pane of a closed tab; the focus stays in the pane that took its place', () => {
        const start = layout(threePanes(), 'p1');
        // The tab of p1 closed and the tabs moved the focus to a hidden neighbour.
        const { layout: next, focus } = reconcile(start, ['s2', 's3', 's4'], 's4');
        expect(sessionsOf(next.root)).toEqual(['s2', 's3']);
        expect(next.activePaneId).toBe('p2');
        expect(focus).toBe('s2');

        // A pane that is not the active one simply goes.
        const other = reconcile(layout(threePanes(), 'p1'), ['s1', 's2'], 's1');
        expect(sessionsOf(other.layout.root)).toEqual(['s1', 's2']);
        expect(other.focus).toBeNull();
    });

    it('keeps the last pane, showing whichever tab has the focus (or nothing)', () => {
        const start = singlePane('p1', 's1');
        expect(sessionsOf(reconcile(start, ['s2'], 's2').layout.root)).toEqual(['s2']);
        expect(sessionsOf(reconcile(start, [], null).layout.root)).toEqual([null]);
    });

    it('never shows a tab in two panes', () => {
        const root = splitPane(pane('p1', 's1'), 'p1', 'row', pane('p2', 's1'), 'x1');
        const { layout: next } = reconcile(layout(root, 'p1'), ['s1'], 's1');
        expect(sessionsOf(next.root)).toEqual(['s1']);
    });
});

describe('remembered shape', () => {
    it('keeps the splits and ratios, not the tabs', () => {
        const root = resizeSplit(threePanes(), 'x1', 0.6);
        const shape = shapeOf(root);
        expect(shapePanes(shape)).toBe(3);
        const stored = JSON.parse(JSON.stringify(shape));
        expect(parseShape(stored)).toEqual(shape);
        let id = 0;
        const rebuilt = fromShape(parseShape(stored)!, (kind) => `${kind}-${(id += 1)}`);
        expect(sessionsOf(rebuilt)).toEqual([null, null, null]);
        expect(paneRects(rebuilt).get(leaves(rebuilt)[0].id)?.w).toBeCloseTo(0.6);
        expect(leafOfSession(rebuilt, 's1')).toBeUndefined();
    });

    it('rejects what is not a shape, and more than MAX_PANES panes', () => {
        const split = (first: unknown, second: unknown) => ({ type: 'split', direction: 'row', ratio: 0.5, first, second });
        const leaf = { type: 'pane' };
        expect(parseShape(null)).toBeNull();
        expect(parseShape('pane')).toBeNull();
        expect(parseShape({ type: 'split', direction: 'diagonal', ratio: 0.5, first: leaf, second: leaf })).toBeNull();
        expect(parseShape({ type: 'split', direction: 'row', first: leaf, second: leaf })).toBeNull();
        expect(parseShape(split(split(leaf, leaf), split(leaf, split(leaf, leaf))))).toBeNull();
        expect(parseShape(split(leaf, leaf))).toEqual(split(leaf, leaf));
        expect(parseShape({ ...split(leaf, leaf), ratio: 7 })).toMatchObject({ ratio: 0.85 });
    });
});
