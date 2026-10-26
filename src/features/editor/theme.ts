// CodeMirror look from the app's theme tokens (CSS custom properties, see
// src/features/appearance/palette.ts): it follows the light and dark theme
// and the accent colour without being rebuilt. The hues are the status hues,
// which turn to darker shades in the light theme, so syntax colours stay
// readable on both. `theme` only picks CodeMirror's own base styles.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';
import type { ResolvedTheme } from '@/features/appearance/model';

const token = (name: string, alpha?: number) => (alpha === undefined ? `rgb(var(--c-${name}))` : `rgb(var(--c-${name}) / ${alpha})`);
// Hover fills and hairlines (the `white` overlay tint of the theme).
const tint = (alpha: number) => `rgb(var(--c-white) / calc(${alpha} * var(--tint-boost)))`;
const border = tint(0.08);
const brand = token('brand-400');

const EDITOR_STYLES = {
    '&': {
        color: token('zinc-200'),
        backgroundColor: token('ink-900'),
        height: '100%',
        fontSize: '13px'
    },
    '.cm-scroller': {
        fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        lineHeight: '1.6'
    },
    '.cm-content': { caretColor: brand, padding: '8px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: brand, borderLeftWidth: '2px' },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: token('brand-400', 0.22)
    },
    '.cm-activeLine': { backgroundColor: tint(0.035) },
    '.cm-gutters': { backgroundColor: token('ink-850'), color: token('zinc-500'), borderRight: `1px solid ${border}` },
    '.cm-activeLineGutter': { backgroundColor: tint(0.04), color: token('zinc-300') },
    '.cm-foldPlaceholder': { backgroundColor: tint(0.06), border: 'none', color: token('zinc-400') },
    '.cm-selectionMatch': { backgroundColor: token('brand-400', 0.12) },
    '.cm-matchingBracket, .cm-nonmatchingBracket': { backgroundColor: token('brand-400', 0.18), outline: 'none' },
    '.cm-searchMatch': { backgroundColor: token('amber-400', 0.25), outline: `1px solid ${token('amber-400', 0.45)}` },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: token('amber-400', 0.45) },
    '.cm-panels': { backgroundColor: token('ink-750'), color: token('zinc-300') },
    '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${border}` },
    '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${border}` },
    '.cm-panel.cm-search': { padding: '6px 10px', fontSize: '12px' },
    // CodeMirror shrinks the panel controls to 70%: too small next to the app's text.
    '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': { fontSize: '12px' },
    '.cm-panel.cm-search label': { marginRight: '8px', display: 'inline-flex', alignItems: 'center', gap: '4px' },
    '.cm-panel.cm-search input[type=checkbox]': { accentColor: token('brand-500') },
    '.cm-textfield': {
        backgroundColor: token('ink-900'),
        border: `1px solid ${tint(0.14)}`,
        borderRadius: '6px',
        color: token('zinc-100'),
        padding: '3px 6px'
    },
    '.cm-textfield:focus': { outline: 'none', borderColor: token('brand-500', 0.6) },
    '.cm-button': {
        backgroundImage: 'none',
        backgroundColor: token('ink-650'),
        border: `1px solid ${tint(0.1)}`,
        borderRadius: '6px',
        color: token('zinc-200'),
        padding: '2px 8px'
    },
    '.cm-button:hover': { backgroundColor: token('ink-600') },
    '.cm-panel.cm-search [name=close]': { color: token('zinc-400') },
    '.cm-tooltip': { backgroundColor: token('ink-700'), border: `1px solid ${border}`, color: token('zinc-200') },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: token('brand-500', 0.2), color: token('zinc-100') }
};

const highlight = HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: token('teal-300') },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: token('amber-300') },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: token('fuchsia-300') },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: token('zinc-500'), fontStyle: 'italic' },
    { tag: [tags.propertyName, tags.attributeName], color: token('sky-300') },
    { tag: [tags.typeName, tags.className, tags.namespace], color: token('green-300') },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: token('blue-300') },
    { tag: [tags.definition(tags.variableName), tags.variableName], color: token('zinc-200') },
    { tag: [tags.tagName, tags.heading], color: token('teal-300'), fontWeight: '600' },
    { tag: [tags.meta, tags.processingInstruction, tags.annotation], color: token('violet-300') },
    { tag: [tags.operator, tags.punctuation, tags.bracket], color: token('zinc-400') },
    { tag: tags.link, color: token('sky-300'), textDecoration: 'underline' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.invalid, color: token('rose-300') }
]);

const syntax = syntaxHighlighting(highlight);
const THEMES: Record<ResolvedTheme, Extension> = {
    dark: [EditorView.theme(EDITOR_STYLES, { dark: true }), syntax],
    light: [EditorView.theme(EDITOR_STYLES, { dark: false }), syntax]
};

export function shellmindEditorTheme(theme: ResolvedTheme): Extension {
    return THEMES[theme];
}
