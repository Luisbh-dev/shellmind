// The Spanish strings as one chunk, loaded by catalog.ts when Spanish is
// first used.
import type { MessageTree } from '../catalog';

const modules = import.meta.glob<MessageTree>('../locales/es/*.ts', { eager: true, import: 'default' });

export default modules;
