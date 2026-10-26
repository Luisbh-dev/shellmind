// Accent colors a server can be marked with. The palette id is what is
// stored (servers.color); older or imported rows may hold a #rrggbb value.

export const SERVER_COLORS = ['teal', 'sky', 'violet', 'rose', 'amber', 'emerald', 'orange'] as const;
export type ServerColor = typeof SERVER_COLORS[number];

// Literal class names so Tailwind keeps them.
const SWATCH: Record<ServerColor, string> = {
    teal: 'bg-teal-400',
    sky: 'bg-sky-400',
    violet: 'bg-violet-400',
    rose: 'bg-rose-400',
    amber: 'bg-amber-400',
    emerald: 'bg-emerald-400',
    orange: 'bg-orange-400'
};

const HEX = /^#[0-9a-f]{6}$/i;

export function isServerColor(value: unknown): value is ServerColor {
    return typeof value === 'string' && (SERVER_COLORS as readonly string[]).includes(value);
}

// How to paint a stored color: a palette class, an inline hex, or nothing.
export function colorStyle(value: string | null | undefined): { className?: string; style?: { backgroundColor: string } } | null {
    if (isServerColor(value)) return { className: SWATCH[value] };
    if (value && HEX.test(value)) return { style: { backgroundColor: value } };
    return null;
}

export function swatchClass(color: ServerColor): string {
    return SWATCH[color];
}
