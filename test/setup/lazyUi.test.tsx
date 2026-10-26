import { getConfig, render, screen } from '@testing-library/react'
import { lazy, Suspense } from 'react'
import { describe, expect, it } from 'vitest'
import { LAZY_UI_TIMEOUT_MS } from './timeouts'

// A lazy chunk that takes longer than Testing Library's 1 s default to arrive,
// as SettingsModal, AddServerModal and RemoteEditor do on a loaded runner.
const SLOW_CHUNK_MS = 1_300

const SlowDialog = lazy(() => new Promise<{ default: () => JSX.Element }>((resolve) => {
  setTimeout(() => resolve({ default: () => <div role="dialog" aria-label="Slow dialog">loaded</div> }), SLOW_CHUNK_MS)
}))

describe('component test setup', () => {
  it('waits for lazily loaded UI longer than Testing Library\'s 1 s default', async () => {
    expect(getConfig().asyncUtilTimeout).toBe(LAZY_UI_TIMEOUT_MS)

    render(<Suspense fallback={<p>loading</p>}><SlowDialog /></Suspense>)

    expect(await screen.findByRole('dialog', { name: 'Slow dialog' })).toHaveTextContent('loaded')
  })
})
