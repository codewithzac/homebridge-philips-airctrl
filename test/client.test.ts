import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhilipsCoapClient, NotConnectedError } from '../src/airctrl/client.js'
import { decrypt, encrypt } from '../src/airctrl/crypto.js'
import { CoapOption, bufferToUint, type DecodedCoapMessage } from '../src/airctrl/coap/message.js'
import type { CoapSocket, Observation } from '../src/airctrl/coap/socket.js'
import { startFakeDevice, pathOf, type FakeDevice } from './helpers/fake-device.js'

describe('PhilipsCoapClient', () => {
  const devices: FakeDevice[] = []
  const clients: PhilipsCoapClient[] = []

  afterEach(async () => {
    for (const client of clients) client.close()
    await Promise.all(devices.map(device => device.close()))
    clients.length = 0
    devices.length = 0
  })

  async function start(
    handler: Parameters<typeof startFakeDevice>[0],
    options?: ConstructorParameters<typeof PhilipsCoapClient>[2],
  ): Promise<{ device: FakeDevice, client: PhilipsCoapClient }> {
    const device = await startFakeDevice(handler)
    const client = new PhilipsCoapClient('127.0.0.1', device.port, options)
    devices.push(device)
    clients.push(client)
    return { device, client }
  }

  /** A client whose control writes take 10ms, so concurrent writes would overlap. */
  async function slowControlClient(): Promise<{
    client: PhilipsCoapClient
    control: { keys: string[], maxInFlight: number }
  }> {
    const client = new PhilipsCoapClient('127.0.0.1', 9999)
    clients.push(client)
    const socket = (client as unknown as { socket: CoapSocket }).socket
    const control = { keys: [] as string[], maxInFlight: 0 }
    let inFlight = 0
    const reply = (payload: string): DecodedCoapMessage => ({
      type: 1,
      code: 69,
      messageId: 1,
      token: Buffer.alloc(0),
      options: [],
      payload: Buffer.from(payload),
    })
    vi.spyOn(socket, 'request').mockImplementation(async options => {
      if (options.path === '/sys/dev/sync') return reply('0DC377BA')
      inFlight++
      control.maxInFlight = Math.max(control.maxInFlight, inFlight)
      control.keys.push(String(options.payload).slice(0, 8))
      try {
        await new Promise(resolve => setTimeout(resolve, 10))
        return reply(JSON.stringify({ status: 'success' }))
      } finally {
        inFlight--
      }
    })
    return { client, control }
  }

  it('reads plaintext device info without syncing', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/info') {
        return { payload: JSON.stringify({ modelid: 'AC4220/12', name: 'Office' }) }
      }
    })

    expect((await client.getInfo()).modelid).toBe('AC4220/12')
    expect(device.requests.map(pathOf)).toEqual(['/sys/dev/info'])
  })

  it('syncs, decrypts status, and reads Max-Age', async () => {
    const { client } = await start(request => {
      switch (pathOf(request)) {
        case '/sys/dev/sync': return { payload: '0DC377BA\n' }
        case '/sys/dev/status': return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: { D03102: 1 } } })),
          options: [{ number: CoapOption.MaxAge, value: Buffer.from([30]) }],
        }
      }
    })

    await client.connect()
    await expect(client.getStatus()).resolves.toEqual({
      status: { D03102: 1 },
      maxAge: 30,
    })
  })

  it('uses Observe 0 for status then cancels with Observe 1 on the same token', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return { payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: {} } })) }
      }
    })
    await client.connect()

    await client.getStatus()
    await waitFor(() => device.requests.filter(request => pathOf(request) === '/sys/dev/status').length === 2)

    const statusRequests = device.requests.filter(request => pathOf(request) === '/sys/dev/status')
    expect(statusRequests.map(observeValue)).toEqual([0, 1])
    expect(statusRequests[0]!.token.equals(statusRequests[1]!.token)).toBe(true)
  })

  it.each([
    ['missing', undefined],
    ['zero', Buffer.alloc(0)],
  ])('defaults %s Max-Age to 60', async (_name, maxAge) => {
    const { client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: {} } })),
          options: maxAge === undefined ? [] : [{ number: CoapOption.MaxAge, value: maxAge }],
        }
      }
    })

    await client.connect()
    expect((await client.getStatus()).maxAge).toBe(60)
  })

  it('yields the initial status and queued pushes, then cancels on return', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: { D03102: 0 } } })),
        }
      }
    })
    await client.connect()

    const iterator = client.observe()
    expect((await iterator.next()).value).toEqual({ D03102: 0 })
    await device.push(encrypt('0DC377BA', JSON.stringify({ state: { reported: { D03102: 1 } } })))
    expect((await iterator.next()).value).toEqual({ D03102: 1 })
    await iterator.return(undefined)

    await waitFor(() => device.requests.filter(request => (
      pathOf(request) === '/sys/dev/status' && observeValue(request) === 1
    )).length === 1)
  })

  it('waits for a later push when the initial Observe notification is quiet', async () => {
    const { client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
    })
    await client.connect()

    const socket = (client as unknown as { socket: CoapSocket }).socket
    let notify!: (message: DecodedCoapMessage) => void
    const refresh = vi.fn()
    const cancel = vi.fn()
    vi.spyOn(socket, 'observe').mockImplementation(async options => {
      notify = options.onNotify
      return { first: undefined, refresh, cancel }
    })

    const iterator = client.observe()
    const next = iterator.next()
    await Promise.resolve()

    notify({
      type: 1,
      code: 69,
      messageId: 2,
      token: Buffer.from('01020304', 'hex'),
      options: [],
      payload: Buffer.from(encrypt(
        '0DC377BA',
        JSON.stringify({ state: { reported: { D03102: 1 } } }),
      )),
    })

    await expect(next).resolves.toEqual({ done: false, value: { D03102: 1 } })
    await iterator.return(undefined)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('ignores a malformed observe push only when explicitly enabled', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: {} } })),
        }
      }
    }, { ignoreMalformedObservePushes: true })
    await client.connect()
    const iterator = client.observe()
    await iterator.next()

    const next = iterator.next()
    await device.push('invalid encrypted payload')
    await device.push(encrypt(
      '0DC377BA',
      JSON.stringify({ state: { reported: { D03102: 1 } } }),
    ))

    await expect(next).resolves.toEqual({ done: false, value: { D03102: 1 } })
    expect(device.requests.some(request => observeValue(request) === 1)).toBe(false)

    await iterator.return(undefined)
    await waitFor(() => device.requests.some(request => observeValue(request) === 1))
  })

  it('preserves the default behavior of rejecting malformed observe pushes', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: {} } })),
        }
      }
    })
    await client.connect()
    const iterator = client.observe()
    await iterator.next()

    const next = iterator.next()
    await device.push('invalid encrypted payload')
    await expect(next).rejects.toThrow()
    await waitFor(() => device.requests.some(request => observeValue(request) === 1))
  })

  it('refreshes only live long-lived observations without changing observe()', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: { D03102: 0 } } })),
        }
      }
    })
    await client.connect()

    // A temporary getStatus observation must not be retained for later refresh.
    await client.getStatus()
    await waitFor(() => device.requests.filter(request => (
      pathOf(request) === '/sys/dev/status' && observeValue(request) === 1
    )).length === 1)

    const first = client.observe()
    const second = client.observe()
    await Promise.all([first.next(), second.next()])

    const before = device.requests.filter(request => (
      pathOf(request) === '/sys/dev/status' && observeValue(request) === 0
    ))
    expect(before).toHaveLength(3)

    expect(client.refreshObservations()).toBe(2)
    await waitFor(() => device.requests.filter(request => (
      pathOf(request) === '/sys/dev/status' && observeValue(request) === 0
    )).length === 5)

    const after = device.requests.filter(request => (
      pathOf(request) === '/sys/dev/status' && observeValue(request) === 0
    ))
    const longLivedTokens = before.slice(1).map(request => request.token.toString('hex')).sort()
    const refreshTokens = after.slice(3).map(request => request.token.toString('hex')).sort()
    expect(refreshTokens).toEqual(longLivedTokens)

    await first.return(undefined)
    await second.return(undefined)
  })

  it('resets live long-lived observations and wakes waiting iterators', async () => {
    const { client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: { D03102: 0 } } })),
        }
      }
    })
    await client.connect()

    const iterator = client.observe()
    await iterator.next()
    const waiting = iterator.next()

    expect(client.resetObservations()).toBe(1)
    await expect(waiting).rejects.toThrow('observation reset')
    expect(client.refreshObservations()).toBe(0)

    await iterator.return(undefined)
  })

  it('sends an encrypted control payload and returns true for success', async () => {
    let desired: Record<string, unknown> | undefined
    const { client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/control') {
        desired = JSON.parse(decrypt(request.payload.toString())).state.desired
        return { payload: JSON.stringify({ status: 'success' }) }
      }
    })
    await client.connect()

    await expect(client.setControl({ D03102: 1 })).resolves.toBe(true)
    expect(desired).toEqual({
      CommandType: 'app',
      DeviceId: '',
      EnduserId: '',
      D03102: 1,
    })
  })

  it('makes the initial attempt plus the configured retries, resyncing only between them', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/control') return { payload: JSON.stringify({ status: 'failed' }) }
    })
    await client.connect()

    await expect(client.setControl({ D03102: 1 }, { retries: 2, retryDelayMs: 1 })).resolves.toBe(false)
    expect(device.requests.filter(request => pathOf(request) === '/sys/dev/control')).toHaveLength(3)
    expect(device.requests.filter(request => pathOf(request) === '/sys/dev/sync')).toHaveLength(3)
    expect(pathOf(device.requests.at(-1)!)).toBe('/sys/dev/control')
  })

  it('caps the total setControl retry-loop wall-clock time when the device never answers control writes', async () => {
    vi.useFakeTimers()
    try {
      const client = new PhilipsCoapClient('127.0.0.1', 9999)
      clients.push(client)
      const socket = (client as unknown as { socket: CoapSocket }).socket
      const request = vi.spyOn(socket, 'request').mockImplementation(options => {
        if (options.path === '/sys/dev/sync') {
          return Promise.resolve({
            type: 1,
            code: 69,
            messageId: 1,
            token: Buffer.alloc(0),
            options: [],
            payload: Buffer.from('0DC377BA'),
          })
        }
        // Control writes never answer — the same failure mode as a device that
        // ACKed /sys/dev/sync but never replies to /sys/dev/control.
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('CoAP timeout')), options.timeoutMs ?? 8000)
        })
      })
      await client.connect()

      const clockStart = Date.now()
      const result = client.setControl({ D03102: 1 })
      await vi.runAllTimersAsync()
      await expect(result).resolves.toBe(false)
      const elapsed = Date.now() - clockStart

      // Old defaults (retries: 5, retryDelayMs: 500, 8s socket timeout) could run
      // ~50s inside a single onSet — well past HAP-NodeJS's ~10s write budget.
      // The retry loop must now stay close to its ~6s budget.
      expect(elapsed).toBeLessThanOrEqual(6500)
      const controlAttempts = request.mock.calls.filter(([options]) => options.path === '/sys/dev/control')
      expect(controlAttempts.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues remaining retries after a resync fails, still bounded by the deadline', async () => {
    // Regression for CodeRabbit F6: a failed resync used to bail out of the
    // whole retry loop via `catch { this.requireOpen(); return false }`. It
    // must now fall through to the next attempt instead, so a single flaky
    // resync doesn't sacrifice every remaining retry.
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/control') return { payload: JSON.stringify({ status: 'failed' }) }
    })
    await client.connect()
    const connect = vi.spyOn(client, 'connect').mockRejectedValueOnce(new Error('sync failed'))

    await expect(client.setControl({ D03102: 1 }, { retries: 2, retryDelayMs: 1 })).resolves.toBe(false)
    // All 3 attempts (initial + 2 retries) still send a control write, even
    // though the very first resync failed.
    expect(device.requests.filter(request => pathOf(request) === '/sys/dev/control')).toHaveLength(3)
    // The failed resync is followed by further resync attempts (the next
    // attempt's own resync), not just the one mocked failure.
    expect(connect.mock.calls.length).toBeGreaterThan(1)
  })

  it('increments the rolling key before every control attempt', async () => {
    const keys: string[] = []
    const { client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/control') {
        keys.push(request.payload.toString().slice(0, 8))
        return { payload: JSON.stringify({ status: 'success' }) }
      }
    })
    await client.connect()

    await client.setControl({ D03102: 1 })
    await client.setControl({ D03102: 0 })
    expect(keys).toEqual(['0DC377BB', '0DC377BC'])
  })

  it('serialises concurrent control writes so the rolling key cannot race', async () => {
    // HAP sends Active + RotationSpeed as one PUT and invokes both onSet handlers at
    // once. Unserialised, the two writes emit K+1 and K+2 as separate NON datagrams
    // that UDP may reorder, and the device rejects the stale one.
    const { client, control } = await slowControlClient()
    await client.connect()

    const results = await Promise.all([
      client.setControl({ D03102: 1 }),
      client.setControl({ D0310C: 2 }),
    ])

    expect(results).toEqual([true, true])
    expect(control.maxInFlight).toBe(1)
    expect(control.keys).toEqual(['0DC377BB', '0DC377BC'])
  })

  it('keeps the control queue usable after a queued write rejects', async () => {
    // A rejected write must not poison the chain for every later write.
    const { client, control } = await slowControlClient()

    await expect(client.setControl({ D03102: 1 })).rejects.toThrow(NotConnectedError)
    await client.connect()

    await expect(client.setControl({ D0310C: 2 })).resolves.toBe(true)
    expect(control.maxInFlight).toBe(1)
  })

  it('lets close() land while a control write is queued behind another', async () => {
    const { client } = await slowControlClient()
    await client.connect()

    const first = client.setControl({ D03102: 1 })
    const second = client.setControl({ D0310C: 2 })
    client.close()

    // Neither call hangs: the in-flight one notices the close on its way out and the
    // queued one rejects when its turn comes.
    await expect(first).rejects.toThrow(/client closed/)
    await expect(second).rejects.toThrow(/client closed/)
  })

  it('requires connect before encrypted operations', async () => {
    const { client } = await start(() => undefined)
    await expect(client.getStatus()).rejects.toThrow(NotConnectedError)
    await expect(client.setControl({ D03102: 1 })).rejects.toThrow(/connect\(\)/)
  })

  it('rejects every public operation once close starts', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
    })
    await client.connect()
    client.close()

    const operations = [
      () => client.getInfo(),
      () => client.connect(),
      () => client.getStatus(),
      () => client.observe().next(),
      async () => client.refreshObservations(),
      async () => client.resetObservations(),
      () => client.setControl({ D03102: 1 }),
    ]
    for (const operation of operations) {
      await expect(operation()).rejects.toThrow(/client closed/)
    }
    expect(device.requests.map(pathOf)).toEqual(['/sys/dev/sync'])
  })

  it.each(['getStatus', 'observe'] as const)(
    'rejects %s when its observe handshake resolves after close',
    async operation => {
      const { client } = await start(request => {
        if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      })
      await client.connect()

      let observeStarted!: () => void
      const started = new Promise<void>(resolve => {
        observeStarted = resolve
      })
      let resolveObservation!: (observation: Observation) => void
      const delayedObservation = new Promise<Observation>(resolve => {
        resolveObservation = resolve
      })
      const socket = (client as unknown as { socket: CoapSocket }).socket
      vi.spyOn(socket, 'observe').mockImplementation(() => {
        observeStarted()
        return delayedObservation
      })
      const cancel = vi.fn()
      const result = operation === 'getStatus'
        ? client.getStatus()
        : client.observe().next()
      await started

      client.close()
      resolveObservation({
        first: {
          type: 1,
          code: 69,
          messageId: 1,
          token: Buffer.from('01020304', 'hex'),
          options: [],
          payload: Buffer.from(encrypt(
            '0DC377BA',
            JSON.stringify({ state: { reported: { D03102: 1 } } }),
          )),
        },
        refresh: vi.fn(),
        cancel,
      })

      await expect(result).rejects.toThrow(/client closed/)
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(['getInfo', 'connect', 'setControl'] as const)(
    'rejects %s when its request resolves after close',
    async operation => {
      const { client } = await start(request => {
        if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      })
      if (operation === 'setControl') await client.connect()

      let requestStarted!: () => void
      const started = new Promise<void>(resolve => {
        requestStarted = resolve
      })
      let resolveRequest!: (response: Awaited<ReturnType<CoapSocket['request']>>) => void
      const delayedRequest = new Promise<Awaited<ReturnType<CoapSocket['request']>>>(resolve => {
        resolveRequest = resolve
      })
      const socket = (client as unknown as { socket: CoapSocket }).socket
      vi.spyOn(socket, 'request').mockImplementation(() => {
        requestStarted()
        return delayedRequest
      })
      const result = operation === 'getInfo'
        ? client.getInfo()
        : operation === 'connect'
          ? client.connect()
          : client.setControl({ D03102: 1 })
      await started

      client.close()
      resolveRequest({
        type: 1,
        code: 69,
        messageId: 1,
        token: Buffer.from('01020304', 'hex'),
        options: [],
        payload: Buffer.from(operation === 'getInfo'
          ? JSON.stringify({ modelid: 'AC4220/12' })
          : operation === 'connect'
            ? '0DC377BA'
            : JSON.stringify({ status: 'success' })),
      })

      await expect(result).rejects.toThrow(/client closed/)
      if (operation === 'connect') {
        expect((client as unknown as { clientKey?: string }).clientKey).toBeUndefined()
      }
    },
  )

  it('cancels every live observation when closed', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: {} } })),
        }
      }
    })
    await client.connect()
    const first = client.observe()
    const second = client.observe()
    await Promise.all([first.next(), second.next()])
    const pending = first.next()

    client.close()

    await expect(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('iterator did not settle')), 100)),
    ])).rejects.toThrow(/client closed/)
    await waitFor(() => device.requests.filter(request => observeValue(request) === 1).length === 2)
    await second.return(undefined)
  })
})

function observeValue(request: { options: { number: number, value: Buffer }[] }): number | undefined {
  const option = request.options.find(candidate => candidate.number === CoapOption.Observe)
  return option && bufferToUint(option.value)
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition was not met')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
