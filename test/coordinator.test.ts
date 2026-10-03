import type { Logging } from 'homebridge'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoInitialStatusError, type PhilipsCoapClient } from '../src/airctrl/client.js'
import { DeviceCoordinator } from '../src/device/coordinator.js'

function logging() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logging
}

function client(status: Record<string, unknown> = { pwr: '1' }, maxAge = 20) {
  const instance = {
    connect: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ status, maxAge }),
    observe: vi.fn(async function* () {
      yield status
      await new Promise(() => {})
    }),
    setControl: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
  }
  return instance as unknown as PhilipsCoapClient & typeof instance
}

function controlledClient(status: Record<string, unknown> = { pwr: '1' }, maxAge = 20) {
  const instance = client(status, maxAge)
  let resolveNext: ((result: IteratorResult<Record<string, unknown>>) => void) | undefined
  let rejectNext: ((error: Error) => void) | undefined
  const iterator = {
    next: vi.fn(() => new Promise<IteratorResult<Record<string, unknown>>>((resolve, reject) => {
      resolveNext = resolve
      rejectNext = reject
    })),
    return: vi.fn(async () => {
      resolveNext?.({ done: true, value: undefined })
      resolveNext = undefined
      rejectNext = undefined
      return { done: true as const, value: undefined }
    }),
    [Symbol.asyncIterator]() {
      return this
    },
  }
  instance.observe = vi.fn(() => iterator) as unknown as typeof instance.observe
  return Object.assign(instance, {
    iterator,
    push(value: Record<string, unknown>) {
      resolveNext?.({ done: false, value })
      resolveNext = undefined
      rejectNext = undefined
    },
    fail(error: Error) {
      rejectNext?.(error)
      resolveNext = undefined
      rejectNext = undefined
    },
    finish() {
      resolveNext?.({ done: true, value: undefined })
      resolveNext = undefined
      rejectNext = undefined
    },
  })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('DeviceCoordinator', () => {
  afterEach(() => vi.useRealTimers())

  it('starts with a one-shot status, availability, observation, and watchdog', async () => {
    vi.useFakeTimers()
    const device = client()
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1')
    const statuses: Record<string, unknown>[] = []
    const availability: boolean[] = []
    coordinator.on('status', status => statuses.push(status))
    coordinator.on('availability', value => availability.push(value))

    await coordinator.start()
    await Promise.resolve()

    expect(device.connect).toHaveBeenCalledOnce()
    expect(device.getStatus).toHaveBeenCalledOnce()
    expect(device.observe).toHaveBeenCalledOnce()
    expect(coordinator.status).toEqual({ pwr: '1' })
    expect(coordinator.available).toBe(true)
    expect(statuses).toEqual([{ pwr: '1' }])
    expect(availability).toEqual([true])
    expect(vi.getTimerCount()).toBe(1)

    coordinator.shutdown()
  })

  it('sends at most two bootstrap nudges when a fresh Observe remains quiet', async () => {
    vi.useFakeTimers()
    const device = controlledClient()
    const coordinator = new DeviceCoordinator(
      device,
      logging(),
      '192.0.2.1',
      undefined,
      { initialStatusNudge: { D0310A: 1 }, initialStatusGraceMs: 1_500 },
    )

    await coordinator.start()
    await flush()

    expect(device.getStatus).not.toHaveBeenCalled()
    expect(device.observe).toHaveBeenCalledOnce()
    expect(device.setControl).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_499)
    expect(device.setControl).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(device.setControl).toHaveBeenCalledOnce()
    expect(device.setControl).toHaveBeenLastCalledWith(
      { D0310A: 1 },
      { retries: 0, resync: false, timeoutMs: 2_000, budgetMs: 2_000 },
    )

    await vi.advanceTimersByTimeAsync(63_499)
    expect(device.setControl).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(device.setControl).toHaveBeenCalledTimes(2)
    expect(device.setControl).toHaveBeenLastCalledWith(
      { D0310A: 1 },
      { retries: 0, resync: false, timeoutMs: 2_000, budgetMs: 2_000 },
    )

    await vi.advanceTimersByTimeAsync(120_000)
    expect(device.setControl).toHaveBeenCalledTimes(2)
    expect(coordinator.status).toBeNull()
    coordinator.shutdown()
  })

  it('cancels the delayed fallback nudge as soon as the first nudge gets a status', async () => {
    vi.useFakeTimers()
    const device = controlledClient()
    const coordinator = new DeviceCoordinator(
      device,
      logging(),
      '192.0.2.1',
      undefined,
      { initialStatusNudge: { D0310A: 1 }, initialStatusGraceMs: 1_500, initialStatusSecondNudgeMs: 65_000 },
    )

    await coordinator.start()
    await vi.advanceTimersByTimeAsync(1_500)
    await flush()
    expect(device.setControl).toHaveBeenCalledOnce()

    device.push({ D03102: 1, D0310A: 1, D0310C: 2 })
    await flush()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(device.setControl).toHaveBeenCalledOnce()
    coordinator.shutdown()
  })

  it('cancels the startup nudge when a quiet device reports during the grace period', async () => {
    vi.useFakeTimers()
    const device = controlledClient()
    const coordinator = new DeviceCoordinator(
      device,
      logging(),
      '192.0.2.1',
      undefined,
      { initialStatusNudge: { D0310A: 1 }, initialStatusGraceMs: 1_500 },
    )

    await coordinator.start()
    await flush()
    device.push({ D03102: 1, D0310A: 1, D0310C: 2 })
    await flush()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(device.setControl).not.toHaveBeenCalled()
    expect(coordinator.status).toEqual({ D03102: 1, D0310A: 1, D0310C: 2 })
    coordinator.shutdown()
  })

  it('keeps a quiet device available and accepts its first later status push', async () => {
    vi.useFakeTimers()
    const device = controlledClient()
    device.getStatus.mockRejectedValue(new NoInitialStatusError())
    const log = logging()
    const coordinator = new DeviceCoordinator(device, log, '192.0.2.1')
    const statuses: Record<string, unknown>[] = []

    coordinator.on('status', status => statuses.push(status))

    await coordinator.start()
    await flush()

    expect(coordinator.available).toBe(true)
    expect(coordinator.status).toBeNull()
    expect(device.observe).toHaveBeenCalledOnce()
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('waiting for initial status'))

    device.push({ pwr: '1', D0310C: 2 })
    await flush()

    expect(coordinator.status).toEqual({ pwr: '1', D0310C: 2 })
    expect(statuses).toEqual([{ pwr: '1', D0310C: 2 }])
    expect(vi.getTimerCount()).toBe(1)

    coordinator.shutdown()
  })

  it('emits only added, removed, or strictly changed status keys', () => {
    vi.useFakeTimers()
    const coordinator = new DeviceCoordinator(client(), logging(), '192.0.2.1')
    const statuses: Record<string, unknown>[] = []
    coordinator.on('status', status => statuses.push(status))

    coordinator.ingest({ a: 1, b: 'x' })
    coordinator.ingest({ a: 1, b: 'x' })
    coordinator.ingest({ a: 1, b: 'y' })
    coordinator.ingest({ a: 1 })
    coordinator.ingest({ a: 1, c: undefined })

    expect(statuses).toEqual([
      { a: 1, b: 'x' },
      { a: 1, b: 'y' },
      { a: 1 },
      { a: 1, c: undefined },
    ])
    expect(vi.getTimerCount()).toBe(1)
    coordinator.shutdown()
  })

  it('emits and logs availability transitions only once', () => {
    const log = logging()
    const coordinator = new DeviceCoordinator(client(), log, '192.0.2.1')
    const availability: boolean[] = []
    coordinator.on('availability', value => availability.push(value))

    coordinator.markUnavailable('not available yet')
    coordinator.markAvailable()
    coordinator.markAvailable()
    coordinator.markUnavailable('timeout')
    coordinator.markUnavailable('still timed out')

    expect(availability).toEqual([true, false])
    expect(log.info).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalledOnce()
    coordinator.shutdown()
  })

  it('provides capped exponential reconnect delays and resets them', () => {
    const coordinator = new DeviceCoordinator(client(), logging(), '192.0.2.1')

    expect(Array.from({ length: 6 }, () => coordinator.nextBackoffMs()))
      .toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000])
    coordinator.resetBackoff()
    expect(coordinator.nextBackoffMs()).toBe(5_000)
    coordinator.shutdown()
  })

  it('delegates control writes to the current client', async () => {
    const device = client()
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1')

    await expect(coordinator.setControl({ pwr: '0' })).resolves.toBe(true)
    expect(device.setControl).toHaveBeenCalledWith({ pwr: '0' })
    coordinator.shutdown()
  })

  it('reconnects after three missed pushes and resets backoff after success', async () => {
    vi.useFakeTimers()
    const first = controlledClient({ pwr: '1' }, 2)
    const replacement = controlledClient({ pwr: '0' }, 4)
    const reconnectClient = vi.fn().mockResolvedValue(replacement)
    const log = logging()
    const coordinator = new DeviceCoordinator(first, log, '192.0.2.1', reconnectClient)
    const availability: boolean[] = []
    coordinator.on('availability', value => availability.push(value))

    await coordinator.start()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(coordinator.available).toBe(false)
    expect(reconnectClient).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(reconnectClient).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(first.close).toHaveBeenCalledOnce()
    expect(reconnectClient).toHaveBeenCalledOnce()
    expect(replacement.connect).toHaveBeenCalledOnce()
    expect(replacement.getStatus).toHaveBeenCalledOnce()
    expect(replacement.observe).toHaveBeenCalledOnce()
    expect(coordinator.status).toEqual({ pwr: '0' })
    expect(coordinator.available).toBe(true)
    expect(availability).toEqual([true, false, true])
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Reconnected'))
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(coordinator.nextBackoffMs()).toBe(5_000)
    coordinator.shutdown()
  })

  it('uses the same one-shot nudge after watchdog reconnect for a quiet device', async () => {
    vi.useFakeTimers()
    const first = controlledClient()
    const replacement = controlledClient()
    const reconnectClient = vi.fn().mockResolvedValue(replacement)
    const coordinator = new DeviceCoordinator(
      first,
      logging(),
      '192.0.2.1',
      reconnectClient,
      { initialStatusNudge: { D0310A: 1 }, initialStatusGraceMs: 1_500, initialStatusSecondNudgeMs: 65_000 },
    )

    await coordinator.start()
    await vi.advanceTimersByTimeAsync(1_500)
    await flush()
    first.push({ D03102: 1, D0310A: 1, D0310C: 2 })
    await flush()

    // The first real status arms the watchdog at the default 60s * 3.
    await vi.advanceTimersByTimeAsync(180_000)
    expect(coordinator.available).toBe(false)

    await vi.advanceTimersByTimeAsync(5_000)
    await flush()

    expect(first.close).toHaveBeenCalledOnce()
    expect(reconnectClient).toHaveBeenCalledOnce()
    expect(replacement.connect).toHaveBeenCalledOnce()
    expect(replacement.getStatus).not.toHaveBeenCalled()
    expect(replacement.observe).toHaveBeenCalledOnce()
    expect(replacement.setControl).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_500)
    await flush()
    expect(replacement.setControl).toHaveBeenCalledOnce()
    expect(replacement.setControl).toHaveBeenCalledWith(
      { D0310A: 1 },
      { retries: 0, resync: false, timeoutMs: 2_000, budgetMs: 2_000 },
    )

    replacement.push({ D03102: 0, D0310A: 1, D0310C: 2 })
    await flush()
    expect(coordinator.status).toEqual({ D03102: 0, D0310A: 1, D0310C: 2 })
    expect(coordinator.available).toBe(true)
    coordinator.shutdown()
  })

  it('emits an unchanged first status after reconnect, then resumes duplicate suppression', async () => {
    vi.useFakeTimers()
    const status = { pwr: '1', pm25: 8 }
    const first = controlledClient(status, 2)
    const replacement = controlledClient(status, 2)
    const coordinator = new DeviceCoordinator(
      first,
      logging(),
      '192.0.2.1',
      vi.fn().mockResolvedValue(replacement),
    )
    const statuses: Record<string, unknown>[] = []
    coordinator.on('status', value => statuses.push(value))

    await coordinator.start()
    await vi.advanceTimersByTimeAsync(11_000)
    await flush()

    expect(statuses).toEqual([status, status])

    replacement.push(status)
    await flush()
    expect(statuses).toEqual([status, status])
    coordinator.shutdown()
  })

  it('cancels a pending reconnect when the current stream recovers', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 2)
    const reconnectClient = vi.fn().mockResolvedValue(controlledClient())
    const log = logging()
    const coordinator = new DeviceCoordinator(device, log, '192.0.2.1', reconnectClient)

    await coordinator.start()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(coordinator.available).toBe(false)

    await vi.advanceTimersByTimeAsync(4_000)
    device.push({ pwr: '1', pm25: 8 })
    await flush()
    expect(coordinator.available).toBe(true)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(1_001)
    expect(reconnectClient).not.toHaveBeenCalled()
    expect(device.close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Reconnected'))
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(coordinator.nextBackoffMs()).toBe(5_000)
    coordinator.shutdown()
  })

  it('deduplicates reconnects and retries failures with the next backoff', async () => {
    vi.useFakeTimers()
    const first = controlledClient({ pwr: '1' }, 10)
    const replacement = controlledClient({ pwr: '0' }, 10)
    const reconnectClient = vi.fn()
      .mockRejectedValueOnce(new Error('factory failed'))
      .mockResolvedValueOnce(replacement)
    const log = logging()
    const coordinator = new DeviceCoordinator(first, log, '192.0.2.1', reconnectClient)
    const availability: boolean[] = []
    coordinator.on('availability', value => availability.push(value))

    await coordinator.start()
    first.fail(new Error('stream failed'))
    await flush()
    coordinator.markUnavailable('same failure')
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(reconnectClient).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(reconnectClient).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(reconnectClient).toHaveBeenCalledTimes(2)
    expect(availability).toEqual([true, false, true])
    expect(log.warn).toHaveBeenCalledOnce()
    coordinator.shutdown()
  })

  it('never retries a permanently closed client without a replacement factory', async () => {
    vi.useFakeTimers()
    const device = controlledClient()
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1')

    await coordinator.start()
    device.fail(new Error('stream failed'))
    await flush()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(device.connect).toHaveBeenCalledOnce()
    expect(device.close).not.toHaveBeenCalled()
    coordinator.shutdown()
  })

  it('keeps a throwing listener out of transport state', () => {
    vi.useFakeTimers()
    const log = logging()
    const coordinator = new DeviceCoordinator(client(), log, '192.0.2.1')
    const seen: Record<string, unknown>[] = []
    const availability: boolean[] = []
    coordinator.on('status', () => {
      throw new Error('consumer blew up')
    })
    coordinator.on('status', status => seen.push(status))
    coordinator.on('availability', () => {
      throw new Error('availability consumer blew up')
    })
    coordinator.on('availability', value => availability.push(value))

    expect(() => coordinator.ingest({ a: 1 })).not.toThrow()
    expect(() => coordinator.markAvailable()).not.toThrow()

    // A consumer bug must not stop the other consumers or the coordinator itself.
    expect(seen).toEqual([{ a: 1 }])
    expect(availability).toEqual([true])
    expect(coordinator.status).toEqual({ a: 1 })
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('consumer blew up'))
    coordinator.shutdown()
  })

  it('arms the backoff on retryStart after a failed initial connect', async () => {
    vi.useFakeTimers()
    const first = controlledClient()
    first.connect.mockRejectedValue(new Error('offline'))
    const replacement = controlledClient({ pwr: '1' }, 10)
    const reconnectClient = vi.fn().mockResolvedValue(replacement)
    const coordinator = new DeviceCoordinator(first, logging(), '192.0.2.1', reconnectClient)

    await expect(coordinator.start()).rejects.toThrow('offline')
    expect(vi.getTimerCount()).toBe(0)

    coordinator.retryStart()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(reconnectClient).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(reconnectClient).toHaveBeenCalledOnce()
    expect(coordinator.status).toEqual({ pwr: '1' })
    expect(coordinator.available).toBe(true)
    coordinator.shutdown()
  })

  it('never double-arms retryStart and never retries after shutdown', async () => {
    vi.useFakeTimers()
    const reconnectClient = vi.fn().mockResolvedValue(controlledClient())
    const coordinator = new DeviceCoordinator(controlledClient(), logging(), '192.0.2.1', reconnectClient)

    coordinator.retryStart()
    coordinator.retryStart()
    expect(vi.getTimerCount()).toBe(1)

    coordinator.shutdown()
    expect(vi.getTimerCount()).toBe(0)
    coordinator.retryStart()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(vi.getTimerCount()).toBe(0)
    expect(reconnectClient).not.toHaveBeenCalled()
  })

  it('shutdown ends observation, clears timers and listeners, and blocks reconnect races', async () => {
    vi.useFakeTimers()
    const first = controlledClient()
    const replacement = controlledClient()
    let rejectConnect!: (error: Error) => void
    replacement.connect.mockImplementation(() => new Promise<void>((_, reject) => {
      rejectConnect = reject
    }))
    const coordinator = new DeviceCoordinator(
      first,
      logging(),
      '192.0.2.1',
      vi.fn().mockResolvedValue(replacement),
    )
    coordinator.on('availability', vi.fn())

    await coordinator.start()
    first.fail(new Error('stream failed'))
    await flush()
    await vi.advanceTimersByTimeAsync(5_000)
    await flush()
    expect(replacement.connect).toHaveBeenCalledOnce()

    coordinator.shutdown()
    rejectConnect(new Error('late failure'))
    await flush()
    await vi.runAllTimersAsync()

    expect(first.iterator.return).toHaveBeenCalledOnce()
    expect(replacement.close).toHaveBeenCalledOnce()
    expect(coordinator.listenerCount('availability')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
