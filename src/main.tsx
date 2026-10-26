// The inline boot script (scripts/themeBoot.ts) put the saved theme on <html>
// before the first paint; the store keeps it in step with Settings and the OS.
import './features/appearance/store'
import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import App from './App'
import { AccessGate } from './components/AccessGate'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { ToastProvider } from './components/ui/Toast'
import { ConfirmProvider } from './components/ui/Confirm'
import { languageReady } from './i18n'
import { captureLaunchParams } from './lib/api'
import { createLogger } from './lib/logger'
import './index.css'

const log = createLogger('app')

// Before anything renders: take the backend address and session token out of
// the launch URL (Electron) so they never linger in the address bar.
captureLaunchParams()

// A chunk that cannot be preloaded (offline, or this build was replaced on
// the server) surfaces where it is used: the panel or dialog offers to load
// it again (src/lib/lazy.tsx).
window.addEventListener('vite:preloadError', (event) => {
  log.warn('A part of the app could not be preloaded', (event as Event & { payload?: unknown }).payload)
})

const render = () => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary scope="app">
      <ToastProvider>
        <ConfirmProvider>
          <AccessGate>
            <App />
          </AccessGate>
        </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)

// The saved language's strings load first (only English is bundled with the
// app), so a Spanish window never flashes English; a failed load shows English.
void languageReady().finally(render)
