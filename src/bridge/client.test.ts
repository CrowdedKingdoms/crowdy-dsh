import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BridgeClient, BridgeError } from './client.js'
import { CROWDY_BRIDGE_PROTOCOL_VERSION, type BridgeFrame } from './protocol.js'

/** Two ends of one channel: frames posted on one side arrive at the other. */
function pair() {
  const listeners: Array<Array<(event: { data: unknown }) => void>> = [[], []]
  const make = (mine: number, theirs: number) => ({
    postMessage(message: unknown) {
      for (const listener of listeners[theirs]!) queueMicrotask(() => listener({ data: message }))
    },
    close() {
      listeners[mine]!.length = 0
    },
    addEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
      listeners[mine]!.push(listener)
    },
  })
  return { worker: make(0, 1), page: make(1, 0) }
}

const NONCE = 'boot-nonce-1'

function pageFrame(
  frame:
    | Omit<Extract<BridgeFrame, { t: 'res' }>, 'v' | 'n' | 'from'>
    | Omit<Extract<BridgeFrame, { t: 'err' }>, 'v' | 'n' | 'from'>
    | Omit<Extract<BridgeFrame, { t: 'event' }>, 'v' | 'n' | 'from'>,
  nonce = NONCE,
): BridgeFrame {
  return { v: CROWDY_BRIDGE_PROTOCOL_VERSION, n: nonce, from: 'page', ...frame } as BridgeFrame
}

describe('BridgeClient', () => {
  it('is unavailable without a channel and says so in the model-facing error', async () => {
    const client = new BridgeClient({})
    assert.equal(client.available, false)
    await assert.rejects(client.request('studio.screenshot', {}), (error: unknown) => error instanceof BridgeError && error.code === 'BRIDGE_UNAVAILABLE')
  })

  it('correlates responses, errors and events with the page', async () => {
    const ends = pair()
    const client = new BridgeClient({ channel: 'test', nonce: NONCE, channelFactory: () => ends.worker, timeoutMs: 500 })
    const seen: unknown[] = []
    ends.page.addEventListener('message', (event) => {
      seen.push(event.data)
      const frame = event.data as BridgeFrame
      if (frame.t !== 'req') return
      if (frame.method === 'studio.runtimeLogs') {
        ends.page.postMessage(pageFrame({ t: 'res', id: frame.id, result: { lines: ['a'], truncated: false } }))
      } else {
        ends.page.postMessage(pageFrame({ t: 'err', id: frame.id, code: 'PAGE_ERROR', message: 'nope' }))
      }
    })

    // Requests before the page said hello are refused locally.
    await assert.rejects(client.request('studio.runtimeLogs', {}), (error: unknown) => error instanceof BridgeError && error.code === 'BRIDGE_UNAVAILABLE')

    // A hello carrying someone else's nonce is not a hello.
    ends.page.postMessage(pageFrame({ t: 'event', event: 'page.hello', payload: { appId: '1', projectId: 'p' } }, 'someone-else'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(client.pagePresent, false)

    const hello = new Promise<void>((resolve) => client.on('page.hello', () => resolve()))
    ends.page.postMessage(pageFrame({ t: 'event', event: 'page.hello', payload: { appId: '1', projectId: 'p' } }))
    await hello
    assert.equal(client.pagePresent, true)

    assert.deepEqual(await client.request('studio.runtimeLogs', { limit: 1 }), { lines: ['a'], truncated: false })
    await assert.rejects(client.request('studio.screenshot', {}), (error: unknown) => error instanceof BridgeError && error.message === 'nope')

    client.emit('worker.fileChanged', { target: 'SERVER', path: 'src/lib.rs' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const emitted = seen.find((frame) => (frame as BridgeFrame).t === 'event') as Extract<BridgeFrame, { t: 'event' }>
    assert.equal(emitted.event, 'worker.fileChanged')
    assert.equal(emitted.from, 'worker')
    assert.equal(emitted.n, NONCE, 'worker frames carry the boot nonce')
  })

  it('refuses to join a channel when the page sent no nonce', async () => {
    const ends = pair()
    const client = new BridgeClient({ channel: 'test', channelFactory: () => ends.worker })
    assert.equal(client.available, false)
  })

  it('times out when the page never answers', async () => {
    const ends = pair()
    const client = new BridgeClient({ channel: 'test', nonce: NONCE, channelFactory: () => ends.worker, timeoutMs: 20 })
    ends.page.postMessage(pageFrame({ t: 'event', event: 'page.hello', payload: { appId: '1', projectId: 'p' } }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await assert.rejects(client.request('game.observe', {}), (error: unknown) => error instanceof BridgeError && error.code === 'BRIDGE_TIMEOUT')
  })
})
