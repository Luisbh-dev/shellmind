import type { CSSProperties } from 'react';
import type { ResolvedTheme } from '@/features/appearance/model';
import type { Tone } from './thresholds';

// Colours of the status charts and meters. Series and status steps of the
// dataviz reference palette, picked per theme and checked (lightness band,
// chroma, colour-blind separation, >= 3:1 contrast) against the card
// surface they sit on: ink-800, #0f1115 in the dark theme, #ffffff in the
// light one. Status colours always come with an icon and a word.
const PALETTE: Record<ResolvedTheme, Record<'series1' | 'series2' | 'good' | 'warn' | 'critical', string>> = {
    dark: { series1: '#3987e5', series2: '#d95926', good: '#0ca30c', warn: '#fab219', critical: '#d03b3b' },
    light: { series1: '#2a78d6', series2: '#eb6834', good: '#0ca30c', warn: '#fab219', critical: '#d03b3b' }
};

function triplet(hex: string): string {
    return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)).join(' ');
}

// The custom properties ("r g b") the dashboard root sets for its theme.
export function vizStyle(theme: ResolvedTheme): CSSProperties {
    const colors = PALETTE[theme];
    return {
        '--viz-series-1': triplet(colors.series1),
        '--viz-series-2': triplet(colors.series2),
        '--viz-good': triplet(colors.good),
        '--viz-warn': triplet(colors.warn),
        '--viz-critical': triplet(colors.critical)
    } as CSSProperties;
}

const color = (name: string) => (alpha?: number) => (alpha === undefined ? `rgb(var(--viz-${name}))` : `rgb(var(--viz-${name}) / ${alpha})`);

export const viz = {
    series1: color('series-1'),
    series2: color('series-2'),
    good: color('good'),
    // The card surface: rings around end dots and the notches of the meters.
    surface: 'rgb(var(--c-ink-800))'
};

// A meter fills with the series colour while fine and turns amber, then red.
const TONE_COLOR: Record<Tone, string> = { ok: 'series-1', warn: 'warn', critical: 'critical' };

export function toneColor(tone: Tone, alpha?: number): string {
    return color(TONE_COLOR[tone])(alpha);
}
