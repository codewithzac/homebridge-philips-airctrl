import dgram from 'node:dgram'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoapOption, decode, encode, findOption, uintToBuffer } from '../src/airctrl/coap/message.js'
import { CoapSocket } from '../src/airctrl/coap/socket.js'

const CONTENT_2_05 = 69
// Longer than vitest's default 5s test timeout, so a regression that makes
// close() leak the pending timer (rather than rejecting promptly) fails loudly.
const DEFAULT_LONG_TIMEOUT_MS = 20000

/** A scriptable fake CoAP device on localhost. */
function fakeDevice(handler: (request: ReturnType<typeof decode>, reply: (m: Parameters<typeof encode>[0]) => void, remote: dgram.RemoteInfo) => void) {
  const server = dgram.createSocket('udp4')
  server.on('message', (buffer, remote) => {
    let request
    try { request = decode(buffer) } catch { return }
    handler(request, message => server.send(encode(message), remote.port, remote.address), remote)
  })
  return {
    server,
    listen: () => new Promise<number>(resolve => server.bind(0, () => resolve(server.address().port))),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

let device: ReturnType<typeof fakeDevice> | null = null
let socket: CoapSocket | null = null

afterEach(async () => {
  socket?.close()
  socket = null
  await device?.close()
  device = null
})

describe('CoapSocket.request', () => {
  it('resolves the response matched by token', async () => {
    device = fakeDevice((request, reply) => {
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('pong') })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const response = await socket.request({ method: 'GET', path: '/sys/dev/info' })
    expect(response.payload.toString()).toBe('pong')
    expect(response.code).toBe(CONTENT_2_05)
  })

  it('sends the path as repeated Uri-Path options and type NON', async () => {
    let seen: ReturnType<typeof decode> | null = null
    device = fakeDevice((request, reply) => {
      seen = request
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('ok') })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    await socket.request({ method: 'POST', path: '/sys/dev/sync', payload: 'NONCE' })
    expect(seen!.type).toBe(1) // NON
    expect(seen!.options.filter(o => o.number === CoapOption.UriPath).map(o => o.value.toString()))
      .toEqual(['sys', 'dev', 'sync'])
    expect(seen!.payload.toString()).toBe('NONCE')
  })

  it('ignores a response bearing an unknown token, then still resolves the right one', async () => {
    device = fakeDevice((request, reply) => {
      reply({ code: CONTENT_2_05, messageId: 1, token: Buffer.from('ffffffff', 'hex'), payload: Buffer.from('wrong') })
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('right') })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    expect((await socket.request({ method: 'GET', path: '/x' })).payload.toString()).toBe('right')
  })

  it('survives a malformed datagram', async () => {
    device = fakeDevice((request, reply, remote) => {
      device!.server.send(Buffer.from([0x00]), remote.port, remote.address) // garbage, ignored
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('ok') })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    expect((await socket.request({ method: 'GET', path: '/x' })).payload.toString()).toBe('ok')
  })

  it('rejects on timeout and leaves no pending handler', async () => {
    device = fakeDevice(() => { /* never replies */ })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    await expect(socket.request({ method: 'GET', path: '/x', timeoutMs: 100 })).rejects.toThrow(/timeout/)
    expect(socket.pendingCount).toBe(0)
  })

  it('close() rejects an in-flight request promptly instead of leaking its timer', async () => {
    device = fakeDevice(() => { /* never replies */ })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const pending = socket.request({ method: 'GET', path: '/x', timeoutMs: DEFAULT_LONG_TIMEOUT_MS })
    const rejection = expect(pending).rejects.toThrow(/closed/)
    socket.close()
    await rejection
    expect(socket.pendingCount).toBe(0)
  })

  it('rejects an async send failure without notifying live observations', async () => {
    device = fakeDevice((request, reply) => {
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const observerErrors: Error[] = []
    await socket.observe({ path: '/status', onNotify: () => {}, onError: error => observerErrors.push(error) })

    const underlying = (socket as unknown as { socket: { send: (...args: unknown[]) => void } }).socket
    underlying.send = (...args) => {
      const callback = args.at(-1)
      if (typeof callback === 'function') callback(new Error('ENOTFOUND'))
    }

    await expect(socket.request({ method: 'GET', path: '/info', timeoutMs: 100 }))
      .rejects.toThrow('ENOTFOUND')
    expect(observerErrors).toEqual([])
    expect(socket.pendingCount).toBe(1)
  })

  it('still receives replies for a hostname-configured device', async () => {
    // A hand-edited config.json can carry a DNS name instead of a literal IP; dgram
    // resolves it to send, but the reply's rinfo.address need not equal the literal
    // hostname string, so the source check must fall back to port-only for it.
    device = fakeDevice((request, reply) => {
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('pong') })
    })
    const port = await device.listen()
    socket = new CoapSocket('localhost', port)

    const response = await socket.request({ method: 'GET', path: '/sys/dev/info' })
    expect(response.payload.toString()).toBe('pong')
  })

  it('drops a datagram from a genuinely wrong source when host is a literal IP', async () => {
    let capturedToken: Buffer | null = null
    device = fakeDevice(request => {
      capturedToken = request.token
      // No reply from the real device; only the spoofed datagram below arrives.
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const pending = socket.request({ method: 'GET', path: '/x', timeoutMs: 100 })
    await vi.waitFor(() => expect(capturedToken).not.toBeNull())

    const underlying = (socket as unknown as {
      socket: { emit: (event: string, buffer: Buffer, rinfo: dgram.RemoteInfo) => void }
    }).socket
    // Same token as the real request, but from an address that isn't 127.0.0.1 — must
    // still be dropped, proving the literal-IP source check still applies.
    underlying.emit('message', encode({ code: CONTENT_2_05, messageId: 1, token: capturedToken! }), {
      address: '10.0.0.9',
      port,
      family: 'IPv4',
      size: 0,
    })

    await expect(pending).rejects.toThrow(/timeout/)
  })
})

describe('CoapSocket.observe', () => {
  it('resolves the first response and streams later pushes', async () => {
    let saved: { token: Buffer, reply: (m: Parameters<typeof encode>[0]) => void } | null = null
    device = fakeDevice((request, reply) => {
      saved = { token: request.token, reply }
      reply({
        code: CONTENT_2_05,
        messageId: request.messageId,
        token: request.token,
        options: [{ number: CoapOption.Observe, value: uintToBuffer(1) }, { number: CoapOption.MaxAge, value: uintToBuffer(60) }],
        payload: Buffer.from('first'),
      })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const pushes: string[] = []
    const observation = await socket.observe({ path: '/sys/dev/status', onNotify: m => pushes.push(m.payload.toString()) })

    expect(observation.first!.payload.toString()).toBe('first')
    expect(findOption(observation.first!.options, CoapOption.MaxAge)).toBeDefined()

    saved!.reply({ code: CONTENT_2_05, messageId: 99, token: saved!.token, payload: Buffer.from('second') })
    await vi.waitFor(() => expect(pushes).toEqual(['second']))
  })

  it('keeps a quiet Observe subscription alive for a later push', async () => {
    let saved: { token: Buffer, reply: (m: Parameters<typeof encode>[0]) => void } | null = null
    device = fakeDevice((request, reply) => {
      saved = { token: request.token, reply }
      // CX3550/01 can accept Observe without sending an initial notification.
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const pushes: string[] = []
    const observation = await socket.observe({
      path: '/sys/dev/status',
      onNotify: message => pushes.push(message.payload.toString()),
      timeoutMs: 20,
      allowQuiet: true,
    })

    expect(observation.first).toBeUndefined()
    expect(socket.pendingCount).toBe(1)

    saved!.reply({
      code: CONTENT_2_05,
      messageId: 99,
      token: saved!.token,
      payload: Buffer.from('later'),
    })
    await vi.waitFor(() => expect(pushes).toEqual(['later']))

    observation.cancel()
    expect(socket.pendingCount).toBe(0)
  })

  it('refreshes an observation with Observe=0 on the same token without replacing it', async () => {
    const requests: ReturnType<typeof decode>[] = []
    let push: ((m: Parameters<typeof encode>[0]) => void) | undefined
    device = fakeDevice((request, reply) => {
      requests.push(request)
      push = reply
      if (requests.length === 1) {
        reply({
          code: CONTENT_2_05,
          messageId: request.messageId,
          token: request.token,
          payload: Buffer.from('first'),
        })
      }
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const pushes: string[] = []
    const observation = await socket.observe({
      path: '/sys/dev/status',
      onNotify: message => pushes.push(message.payload.toString()),
    })
    const token = requests[0]!.token

    observation.refresh()
    await vi.waitFor(() => expect(requests).toHaveLength(2))

    expect(findOption(requests[1]!.options, CoapOption.Observe)!.value.toString('hex')).toBe('')
    expect(requests[1]!.token.equals(token)).toBe(true)
    expect(socket.pendingCount).toBe(1)

    push!({
      code: CONTENT_2_05,
      messageId: 99,
      token,
      payload: Buffer.from('refreshed'),
    })
    await vi.waitFor(() => expect(pushes).toEqual(['refreshed']))

    observation.cancel()
  })

  it('does not fail a live observation when a best-effort refresh send fails', async () => {
    device = fakeDevice((request, reply) => {
      reply({
        code: CONTENT_2_05,
        messageId: request.messageId,
        token: request.token,
        payload: Buffer.from('first'),
      })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const errors: Error[] = []
    const observation = await socket.observe({
      path: '/sys/dev/status',
      onNotify: () => {},
      onError: error => errors.push(error),
    })

    const underlying = (socket as unknown as { socket: { send: (...args: unknown[]) => void } }).socket
    underlying.send = (...args) => {
      const callback = args.at(-1)
      if (typeof callback === 'function') callback(new Error('refresh send failure'))
    }

    observation.refresh()
    await new Promise(resolve => setImmediate(resolve))

    expect(errors).toEqual([])
    expect(socket.pendingCount).toBe(1)
    observation.cancel()
  })

  it('cancel() sends the same token with Observe=1 and stops notifications', async () => {
    const requests: ReturnType<typeof decode>[] = []
    let saved: { token: Buffer, reply: (m: Parameters<typeof encode>[0]) => void } | null = null
    device = fakeDevice((request, reply) => {
      requests.push(request)
      const observe = findOption(request.options, CoapOption.Observe)
      if (observe && observe.value.length > 0) return // cancellation, no reply
      saved = { token: request.token, reply }
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('first') })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const pushes: string[] = []
    const observation = await socket.observe({ path: '/sys/dev/status', onNotify: m => pushes.push(m.payload.toString()) })
    observation.cancel()
    await new Promise(resolve => setTimeout(resolve, 50))

    // The cancellation carries the same token and Observe = 1.
    const cancellation = requests.at(-1)!
    expect(cancellation.token.toString('hex')).toBe(observation.first!.token.toString('hex'))
    expect(findOption(cancellation.options, CoapOption.Observe)!.value.toString('hex')).toBe('01')

    // A push arriving after cancellation must be dropped.
    saved!.reply({ code: CONTENT_2_05, messageId: 100, token: saved!.token, payload: Buffer.from('late') })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(pushes).toEqual([])
    expect(socket.pendingCount).toBe(0)
  })

  it.each([
    ['synchronous', false],
    ['asynchronous', false],
    ['asynchronous after close', true],
  ] as const)('handles %s cancellation send failures', async (mode, closeBeforeError) => {
    device = fakeDevice((request, reply) => {
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const errors: Error[] = []
    const observation = await socket.observe({
      path: '/status',
      onNotify: () => {},
      onError: error => errors.push(error),
    })

    const underlying = (socket as unknown as { socket: { send: (...args: unknown[]) => void } }).socket
    let sendCallback: ((error: Error) => void) | undefined
    underlying.send = (...args) => {
      const error = new Error(`${mode} send failure`)
      if (mode === 'synchronous') throw error
      const callback = args.at(-1)
      // typeof narrows to the built-in `Function` type, not our specific
      // signature — cast at this use site since we know it's the send error
      // callback CoAP libraries pass as the last argument.
      if (typeof callback === 'function') sendCallback = callback as (error: Error) => void
    }

    observation.cancel()
    if (closeBeforeError) socket.close()
    sendCallback?.(new Error(`${mode} send failure`))

    expect(errors.map(error => error.message)).toEqual(closeBeforeError ? [] : [`${mode} send failure`])
    expect(socket.pendingCount).toBe(0)
  })

  it('propagates a socket-level error to a live observation onError', async () => {
    device = fakeDevice((request, reply) => {
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('first') })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const errors: Error[] = []
    const observation = await socket.observe({
      path: '/sys/dev/status',
      onNotify: () => {},
      onError: error => errors.push(error),
    })
    expect(observation.first!.payload.toString()).toBe('first')

    // The underlying dgram socket is a private implementation detail; poke its
    // 'error' event directly rather than trying to provoke a real network error.
    const underlying = (socket as unknown as { socket: { emit: (event: string, error: Error) => void } }).socket
    underlying.emit('error', new Error('ENETUNREACH'))

    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toBe('ENETUNREACH')
  })
})
