import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeChatFailure } from '../../src/features/chat/lib/chatErrors'
import { ChatStreamError, readChatResponse } from '../../src/features/chat/lib/chatStream'
import { ApiError, apiStream, captureLaunchParams } from '../../src/lib/api'
import { errorReply, hangReply, jsonReply, startAnthropicMock, streamReply, type AnthropicMock } from '../helpers/anthropicMock'
import { bootTestServer, type TestServer } from '../helpers/testServer'

// The two halves of POST /api/chat together: the UI's request (apiStream) and
// reader (readChatResponse, describeChatFailure) against the real backend,
// which talks to an in-process Anthropic-compatible proxy. Covers what the UI
// tests never see from a real server: error events, a stream that ends early,
// and the JSON answer.

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer
let mock: AnthropicMock

beforeAll(async () => {
  mock = await startAnthropicMock()
  server = await bootTestServer({ env: { MINIMAX_PROXY_URL: mock.url } })
  window.history.replaceState(null, '', `/?api=${encodeURIComponent(server.baseUrl)}&token=${encodeURIComponent(server.token)}`)
  captureLaunchParams()
})

afterAll(async () => {
  await server?.close()
  await mock?.close()
})

beforeEach(() => {
  mock.requests.length = 0
})

// What the chat panel sends (useChatStream).
const ask = (body: Record<string, unknown> = {}) => apiStream('/api/chat', { message: 'check nginx status', model: 'MiniMax-M3', stream: true, ...body })

describe('chat stream against the real backend', () => {
  it('reads a streamed answer, announcing the model and every delta', async () => {
    mock.queue(streamReply(['Run ', '`systemctl status nginx`.']))
    const models: string[] = []
    const deltas: string[] = []
    const answer = await readChatResponse(await ask(), { onModel: (model) => models.push(model), onDelta: (text) => deltas.push(text) })

    expect(answer).toEqual({ text: 'Run `systemctl status nginx`.', usedModel: 'MiniMax-M3', stopReason: undefined, models: ['MiniMax-M3'] })
    expect(models).toEqual(['MiniMax-M3'])
    expect(deltas).toEqual(['Run ', '`systemctl status nginx`.'])
  })

  it('reports the model fallback the backend made', async () => {
    mock.queue(errorReply(529, 'Overloaded', 'overloaded_error'), streamReply(['from the fallback']))
    const answer = await readChatResponse(await ask())
    expect(answer.models).toEqual(['MiniMax-M3', 'MiniMax-M3.1-Flash'])
    expect(answer.usedModel).toBe('MiniMax-M3.1-Flash')
  })

  it('turns a mid-stream provider error into a ChatStreamError with its code, after the partial text', async () => {
    mock.queue(streamReply(['Partial'], { ending: 'error', errorMessage: 'Overloaded' }))
    const deltas: string[] = []
    const error = await readChatResponse(await ask(), { onDelta: (text) => deltas.push(text) }).catch((failure: unknown) => failure)

    expect(deltas).toEqual(['Partial'])
    expect(error).toBeInstanceOf(ChatStreamError)
    expect(error).toMatchObject({ code: 'AI_PROVIDER_ERROR', message: expect.stringContaining('Overloaded') })
    expect(describeChatFailure(error)).toEqual({ key: 'chat.errors.provider', params: { detail: expect.stringContaining('Overloaded') } })
  })

  it('never takes a stream the provider cut off for a complete answer', async () => {
    mock.queue(streamReply(['Half an answ'], { ending: 'truncate' }))
    const error = await readChatResponse(await ask()).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ChatStreamError)
  })

  it('rejects when the backend goes away mid-stream, instead of resolving with the partial text', async () => {
    mock.queue(hangReply(true))
    const controller = new AbortController()
    const res = await apiStream('/api/chat', { message: 'check nginx status', stream: true }, { signal: controller.signal })
    const reading = readChatResponse(res)
    await vi.waitFor(() => expect(mock.requests).toHaveLength(1))
    controller.abort()
    await expect(reading).rejects.toBeTruthy()
  })

  it('reads the JSON answer of a request without stream', async () => {
    mock.queue(jsonReply('df -h'))
    const deltas: string[] = []
    const answer = await readChatResponse(await ask({ stream: false }), { onDelta: (text) => deltas.push(text) })
    expect(answer).toEqual({ text: 'df -h', usedModel: 'MiniMax-M3', stopReason: undefined, models: ['MiniMax-M3'] })
    expect(deltas).toEqual(['df -h'])
  })

  it('reports a provider that refuses the request as an error event of the stream', async () => {
    mock.queue(errorReply(400, 'invalid request: context too long'))
    const error = await readChatResponse(await ask()).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ChatStreamError)
    expect(error).toMatchObject({ code: 'AI_PROVIDER_ERROR', message: expect.stringContaining('context too long') })
    expect(describeChatFailure(error).key).toBe('chat.errors.provider')
  })

  it('surfaces the same failure without stream as an ApiError with the backend\'s code', async () => {
    mock.queue(errorReply(400, 'invalid request: context too long'))
    const error = await ask({ stream: false }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 502, body: { code: 'AI_PROVIDER_ERROR' } })
    expect(describeChatFailure(error)).toEqual({ key: 'chat.errors.provider', params: { detail: expect.stringContaining('context too long') } })
  })

  it('surfaces a refused request as invalid', async () => {
    const error = await apiStream('/api/chat', { stream: true }).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ status: 400 })
    expect(describeChatFailure(error).key).toMatch(/^chat\.errors\./)
  })
})
