// Vitest setup file of the component tests (vitest.config.ts), not part of
// the app: code the app loads on first use is loaded up front, so tests see
// it render synchronously, as it does in the app once loaded.
import { preloadMarkdown } from '@/features/chat/components/LazyMarkdown';

await preloadMarkdown();
