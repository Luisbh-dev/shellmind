import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'
import { LAZY_UI_TIMEOUT_MS } from './timeouts'

// Dialogs, panels and the editor are React.lazy chunks. A test's first import
// of one has Vite transform that chunk's whole module graph, which under a
// full parallel run (or a slow CI runner) takes longer than Testing Library's
// 1 s default for findBy*/waitFor.
configure({ asyncUtilTimeout: LAZY_UI_TIMEOUT_MS })

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup()
})
