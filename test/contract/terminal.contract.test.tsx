import { act, renderHook, waitFor } from '@testing-library/react'
import { io, type Socket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { HostKeyMismatchPayload } from '../../shared/protocol'
import { useTerminalSocket, type SessionEvents } from '../../src/features/terminal/useTerminalSocket'
import type { XtermHandle } from '../../src/features/terminal/useXterm'
import { t } from '../../src/i18n'
import { captureLaunchParams } from '../../src/lib/api'
import type { WorkspaceServer } from '../../src/workspace/types'
import { HARNESS_OS, startSshServer, type SshHarness } from '../helpers/sshServer'
import { bootTestServer, type TestServer } from '../helpers/testServer'

// The two halves of the terminal protocol together: the UI's terminal socket
// (useTerminalSocket, with the app's own socket factory and launch
// parameters) against the real backend and an in-process SSH server. The UI
// tests mock the socket and the backend tests drive it by hand; this checks
// that they still speak the same protocol, including the remote shell ending
// on its own and the host key trust flow.

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer
const harnesses: SshHarness[] = []
const sockets: Socket[] = []

// The slice of xterm the hook uses: output is collected, writes complete
// asynchronously as in xterm (the hook acknowledges them then).
function fakeXterm() {
  let output = ''
  const decoder = new TextDecoder()
  const term = {
    cols: 100,
    rows: 30,
    // Read on reconnect, to leave a full-screen program the last session left on.
    buffer: { active: { type: 'normal' } },
    // SSH output arrives as bytes, the app's own notices as text.
    write: (data: string | Uint8Array, done?: () => void) => {
      output += typeof data === 'string' ? data : decoder.decode(data, { stream: true })
      if (done) setTimeout(done, 0)
    },
    writeln: (data: string) => { output += `${data}\r\n` },
    onResize: () => ({ dispose: () => undefined }),
  }
  return { handle: { term, search: {}, fit: () => undefined } as unknown as XtermHandle, output: () => output }
}

function events() {
  return {
    onOutput: vi.fn<SessionEvents['onOutput']>(),
    onOsDetected: vi.fn<SessionEvents['onOsDetected']>(),
    onHostKeyTrusted: vi.fn<SessionEvents['onHostKeyTrusted']>(),
  }
}

async function saveServer(harness: SshHarness): Promise<WorkspaceServer> {
  const res = await server.fetch('/api/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `contract-${harness.port}`, ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'secret' }),
  })
  return ((await res.json()) as { data: WorkspaceServer }).data
}

async function harness(options: Parameters<typeof startSshServer>[0] = {}): Promise<SshHarness> {
  const started = await startSshServer(options)
  harnesses.push(started)
  return started
}

// Another terminal tab of the same server, as a bare socket.
async function rawTab(serverId: number): Promise<Socket> {
  const socket = io(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } })
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('connection-ready', () => resolve())
    socket.once('ssh-error', (message: string) => reject(new Error(message)))
    socket.on('connect', () => socket.emit('start-ssh', { serverId, purpose: 'terminal', cols: 80, rows: 24 }))
  })
  return socket
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  server = await bootTestServer()
  // The page is opened the way the desktop app opens it.
  window.history.replaceState(null, '', `/?api=${encodeURIComponent(server.baseUrl)}&token=${encodeURIComponent(server.token)}`)
  captureLaunchParams()
})

afterEach(() => {
  while (sockets.length) sockets.pop()?.disconnect()
})

afterAll(async () => {
  await server?.close()
  await Promise.all(harnesses.map((started) => started.close()))
  vi.restoreAllMocks()
})

describe('useTerminalSocket against the real backend', () => {
  it('connects with the launch parameters, pins the host key, echoes input and reports the OS', async () => {
    const ssh = await harness()
    const target = await saveServer(ssh)
    const xterm = fakeXterm()
    const handlers = events()
    const { result, unmount } = renderHook(() => useTerminalSocket(target, xterm.handle, handlers))

    await waitFor(() => expect(result.current.state).toBe('connected'))
    expect(handlers.onHostKeyTrusted).toHaveBeenCalledWith(expect.objectContaining({ host: ssh.host, port: ssh.port, fingerprint: ssh.fingerprint }))

    act(() => { expect(result.current.send('hello\r')).toBe(true) })
    await waitFor(() => expect(xterm.output()).toContain('you typed: hello'))
    // Every write was acknowledged and reported, with the terminal size.
    expect(handlers.onOutput).toHaveBeenCalledWith(expect.any(String), { cols: 100, rows: 30 })
    await waitFor(() => expect(handlers.onOsDetected).toHaveBeenCalledWith(HARNESS_OS))
    unmount()
  })

  it('ends the session when the remote shell exits, and frees its shell slot on the pooled connection', async () => {
    const ssh = await harness()
    const target = await saveServer(ssh)
    const xterm = fakeXterm()
    const { result, unmount } = renderHook(() => useTerminalSocket(target, xterm.handle, events()))
    await waitFor(() => expect(result.current.state).toBe('connected'))
    // A second tab: the connection now holds its share of shells (2).
    await rawTab(target.id)
    expect(ssh.connections()).toBe(1)

    act(() => { result.current.send('exit\r') })
    await waitFor(() => expect(result.current.state).toBe('disconnected'))
    expect(xterm.output()).toContain(t('terminal.notice.closed'))

    // The slot of the shell that ended is free again: a new tab fits on the
    // same connection instead of opening a spare one.
    const again = await rawTab(target.id)
    expect(ssh.connections()).toBe(1)
    again.emit('ssh-input', 'still\r')
    await waitFor(() => expect(ssh.log.filter((entry) => entry === 'shell')).toHaveLength(3))
    unmount()
  })

  it('trusts a changed host key the user confirmed, then connects on reconnect', async () => {
    const ssh = await harness()
    const target = await saveServer(ssh)
    const { knownHostsRepo } = await import('../../server/db/knownHostsRepo')
    const old = `SHA256:${'B'.repeat(43)}`
    await knownHostsRepo.pin({ host: ssh.host, port: ssh.port, key_type: 'ssh-ed25519', fingerprint: old })

    const xterm = fakeXterm()
    const { result, unmount } = renderHook(() => useTerminalSocket(target, xterm.handle, events()))
    await waitFor(() => expect(result.current.mismatch).not.toBeNull())
    const mismatch = result.current.mismatch as HostKeyMismatchPayload
    expect(mismatch).toMatchObject({ code: 'HOST_KEY_MISMATCH', expected: old, actual: ssh.fingerprint })

    expect(await result.current.trustHostKey(mismatch)).toMatchObject({ ok: true })
    act(() => result.current.reconnect())
    await waitFor(() => expect(result.current.state).toBe('connected'))
    expect(result.current.mismatch).toBeNull()
    unmount()
  })
})
