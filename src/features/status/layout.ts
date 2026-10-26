// The dashboard grids. They follow the width of the panel (a container query
// on the scroll area), not the window: the sidebar and the chat take part of it.

// The KPI tiles pair up early (a 1024 px window with the chat open leaves
// about 26rem), so the charts still start on the first screen.
export const KPI_GRID = 'grid grid-cols-1 gap-3 [@container(min-width:22rem)]:grid-cols-2 [@container(min-width:56rem)]:grid-cols-4';
export const KPI_GRID_THREE = 'grid grid-cols-1 gap-3 [@container(min-width:22rem)]:grid-cols-2 [@container(min-width:40rem)]:grid-cols-3';
// The tile that ends a two-column row of three alone takes the whole row.
export const KPI_WIDE = '[@container(min-width:22rem)]:col-span-2 [@container(min-width:40rem)]:col-span-1';
// Tighter tiles while they are two to a narrow row.
export const TILE_PADDING = 'p-3 [@container(min-width:40rem)]:p-4';
export const CHART_GRID = 'grid grid-cols-1 gap-3 [@container(min-width:36rem)]:grid-cols-2 [@container(min-width:60rem)]:grid-cols-3';
// The chart that ends a two-column row alone takes the whole row.
export const CHART_WIDE = '[@container(min-width:36rem)]:col-span-2 [@container(min-width:60rem)]:col-span-1';
export const DETAIL_GRID = 'grid grid-cols-1 items-start gap-3 [@container(min-width:60rem)]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]';
// Values that are no longer current: dimmed, but the small print stays legible.
export const STALE_DIM = 'opacity-75 grayscale-[40%]';
