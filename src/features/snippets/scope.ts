import type { ServerType } from '@shared/types';

// Server types a snippet can be typed into: every type with a terminal tab
// (src/workspace/tabs/terminal.tsx), so the ones a snippet can be scoped to.
export const hasTerminal = (type: ServerType): boolean => type !== 's3';
