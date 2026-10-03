import { Accessory, Characteristic, HapStatusError, HAPStatus, Service, uuid } from '@homebridge/hap-nodejs'
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceStatus } from '../src/airctrl/schema.js'
import { Gen1Key, Gen3Key } from '../src/device/keys.js'
import register from '../src/index.js'
import { accessoryUuidSeed, devicesToPrune, PhilipsAirPlatform } from '../src/platform.js'
import { PLATFORM_NAME } from '../src/settings.js'

interface FakeDevice {
  status?: DeviceStatus
  error?: Error
  connect?: Promise<void>
}

class TestPlatformAccessory extends Accessory {
  context: Record<string, unknown> = {}
}

const fakeDevices = vi.hoisted(() => new Map<string, FakeDevice>())
const fakeClients = vi.hoisted(() => new Map<string, {
  close: ReturnType<typeof vi.fn>
  setControl: ReturnType<typeof vi.fn>
}>())
const fakeClientCreations = vi.hoisted(() => new Map<string, number>())

vi.mock('../src/airctrl/client.js', () => ({
  PhilipsCoapClient: class {
    readonly close = vi.fn()
    readonly setControl = vi.fn(async () => true)
    readonly refreshObservations = vi.fn(() => 1)
    readonly resetObservations = vi.fn(() => 1)

    constructor(private readonly host: string) {
      fakeClients.set(host, this)
      fakeClientCreations.set(host, (fakeClientCreations.get(host) ?? 0) + 1)
    }

    async connect(): Promise<void> {
      await fakeDevices.get(this.host)?.connect
      const error = fakeDevices.get(this.host)?.error
      if (error) throw error
    }

    async getStatus(): Promise<{ status: DeviceStatus, maxAge: number }> {
      return { status: fakeDevices.get(this.host)?.status ?? {}, maxAge: 60 }
    }

    async getInfo(): Promise<{ modelid?: string }> {
      return { modelid: String(fakeDevices.get(this.host)?.status?.[Gen3Key.MODEL_ID] ?? '') }
    }

    observe(): AsyncIterable<DeviceStatus> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<DeviceStatus>>(() => {}),
          return: async () => ({ done: true, value: undefined }),
        }),
      }
    }
  },
}))

function log(): Logging {
  return Object.assign(vi.fn(), {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    prefix: '',
  }) as unknown as Logging
}

function api(): API & {
  events: Map<string, () => void>
  registered: PlatformAccessory[]
  updated: PlatformAccessory[]
  unregistered: PlatformAccessory[]
} {
  const events = new Map<string, () => void>()
  const registered: PlatformAccessory[] = []
  const updated: PlatformAccessory[] = []
  const unregistered: PlatformAccessory[] = []
  const value = {
    // Ambient const enums have no runtime object to import — build the
    // subset of HAPStatus the code under test actually reads via already
    // allowed property access on the enum's own members (TS2475).
    hap: {
      Characteristic,
      HapStatusError,
      HAPStatus: { SUCCESS: HAPStatus.SUCCESS, SERVICE_COMMUNICATION_FAILURE: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      Service,
      uuid,
    },
    platformAccessory: TestPlatformAccessory,
    on: vi.fn((event: string, listener: () => void) => {
      events.set(event, listener)
      return value
    }),
    registerPlatform: vi.fn(),
    registerPlatformAccessories: vi.fn((
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory[],
    ) => registered.push(...accessories)),
    updatePlatformAccessories: vi.fn((accessories: PlatformAccessory[]) => updated.push(...accessories)),
    unregisterPlatformAccessories: vi.fn((
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory[],
    ) => unregistered.push(...accessories)),
    events,
    registered,
    updated,
    unregistered,
  }
  return value as unknown as ReturnType<typeof api>
}

function config(hosts: string[]): PlatformConfig {
  return {
    platform: PLATFORM_NAME,
    devices: hosts.map(host => ({
      host,
      exposeSleepSwitch: false,
      exposeAutoPlusSwitch: false,
      exposeBeepSwitch: false,
      exposeLight: false,
    })),
  }
}

function gen3Status(model = 'AC4220/12', deviceIdKey: string = Gen1Key.DEVICE_ID): DeviceStatus {
  return {
    [deviceIdKey]: 'stable-device-id',
    [Gen3Key.NAME]: 'Living Room',
    [Gen3Key.MODEL_ID]: model,
    [Gen3Key.POWER]: 1,
    [Gen3Key.MODE_B]: 1,
    [Gen3Key.PM25]: 8,
  }
}

function cached(name: string, seed: string, host: string): PlatformAccessory {
  const accessory = new TestPlatformAccessory(name, uuid.generate(seed)) as unknown as PlatformAccessory
  accessory.context.device = { host }
  return accessory
}

async function launch(mockApi: ReturnType<typeof api>): Promise<void> {
  mockApi.events.get('didFinishLaunching')!()
  await vi.waitFor(() => {
    expect(mockApi.registerPlatformAccessories).toHaveBeenCalled()
  })
}

beforeEach(() => {
  fakeDevices.clear()
  fakeClients.clear()
  fakeClientCreations.clear()
})

describe('platform helpers', () => {
  it('prefers a stable device id so a DHCP change keeps the accessory', () => {
    expect(accessoryUuidSeed({ host: '192.168.20.151' }, '96868ce0')).toBe('96868ce0')
  })

  it('falls back to the host when the device id is unknown', () => {
    expect(accessoryUuidSeed({ host: '192.168.20.151' }, undefined)).toBe('192.168.20.151')
  })

  it('returns only cached accessories whose UUID is no longer configured', () => {
    const accessories = [{ UUID: 'a' }, { UUID: 'b' }, { UUID: 'c' }]
    expect(devicesToPrune(accessories, new Set(['a', 'c']))).toEqual([{ UUID: 'b' }])
  })
})

describe('registration', () => {
  it('registers the dynamic platform', () => {
    const mockApi = api()
    register(mockApi)
    expect(mockApi.registerPlatform).toHaveBeenCalledWith(PLATFORM_NAME, PhilipsAirPlatform)
  })
})

describe('PhilipsAirPlatform', () => {
  it('waits for didFinishLaunching and registers a device using its current DeviceId key', async () => {
    const mockApi = api()
    fakeDevices.set('192.0.2.1', { status: gen3Status() })
    new PhilipsAirPlatform(log(), config(['192.0.2.1']), mockApi)

    expect(mockApi.registered).toEqual([])
    await launch(mockApi)

    expect(mockApi.registered).toHaveLength(1)
    expect(mockApi.registered[0]?.UUID).toBe(uuid.generate('stable-device-id'))
    expect(mockApi.registered[0]?.displayName).toBe('Living Room')
  })

  it('accepts the Gen3 serial key as a stable id', async () => {
    const mockApi = api()
    fakeDevices.set('192.0.2.2', { status: gen3Status('AC4220/12', Gen3Key.SERIAL) })
    new PhilipsAirPlatform(log(), config(['192.0.2.2']), mockApi)

    await launch(mockApi)

    expect(mockApi.registered[0]?.UUID).toBe(uuid.generate('stable-device-id'))
  })

  it('restores a matching cached accessory without registering a duplicate', async () => {
    const mockApi = api()
    const platform = new PhilipsAirPlatform(log(), config(['192.0.2.1']), mockApi)
    const existing = cached('Old Name', 'stable-device-id', '192.0.2.1')
    platform.configureAccessory(existing)
    fakeDevices.set('192.0.2.1', { status: gen3Status() })

    mockApi.events.get('didFinishLaunching')!()
    await vi.waitFor(() => expect(mockApi.updated).toEqual([existing]))

    expect(mockApi.registered).toEqual([])
    expect(existing.displayName).toBe('Living Room')
  })

  it('keeps a configured cached accessory retrying and unreachable while pruning a removed one', async () => {
    vi.useFakeTimers()
    try {
      const mockApi = api()
      const platformLog = log()
      const platform = new PhilipsAirPlatform(platformLog, config(['192.0.2.1']), mockApi)
      const configured = cached('Offline', 'offline-id', '192.0.2.1')
      const stale = configured.addService(Service.AirPurifier, 'Offline')
      stale.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE)
      const removed = cached('Removed', 'removed-id', '192.0.2.9')
      platform.configureAccessory(configured)
      platform.configureAccessory(removed)
      fakeDevices.set('192.0.2.1', { error: new Error('offline') })

      mockApi.events.get('didFinishLaunching')!()
      await vi.advanceTimersByTimeAsync(0)

      expect(mockApi.unregistered).toEqual([removed])
      expect(platformLog.error).toHaveBeenCalledWith(expect.stringContaining('offline'))
      expect(mockApi.registered).toEqual([])
      // The device is kept and a retry is pending, so it recovers without a Homebridge restart.
      expect(fakeClients.get('192.0.2.1')?.close).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      // The cached accessory reports No Response instead of serving stale values.
      const active = stale.getCharacteristic(Characteristic.Active)
      expect(active.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
      await expect(active.handleGetRequest()).rejects.toBeDefined()
      await expect(active.handleSetRequest(Characteristic.Active.INACTIVE)).rejects.toBeDefined()

      // Shutdown cancels the pending retry: nothing reconnects afterwards and no timer survives.
      mockApi.events.get('shutdown')!()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(fakeClientCreations.get('192.0.2.1')).toBe(1)
      expect(mockApi.registered).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a device that is offline at startup and attaches it once it appears', async () => {
    vi.useFakeTimers()
    try {
      const mockApi = api()
      fakeDevices.set('192.0.2.1', { error: new Error('offline') })
      new PhilipsAirPlatform(log(), config(['192.0.2.1']), mockApi)

      mockApi.events.get('didFinishLaunching')!()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockApi.registered).toEqual([])

      fakeDevices.set('192.0.2.1', { status: gen3Status() })
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(fakeClientCreations.get('192.0.2.1')).toBe(2)
      expect(mockApi.registered).toHaveLength(1)
      expect(mockApi.registered[0]?.UUID).toBe(uuid.generate('stable-device-id'))
      const purifier = mockApi.registered[0]!.getService(Service.AirPurifier)!
      await expect(purifier.getCharacteristic(Characteristic.Active).handleGetRequest())
        .resolves.toBe(Characteristic.Active.ACTIVE)

      mockApi.events.get('shutdown')!()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears every offline handler it installed, not just the ones the accessory re-registers', async () => {
    vi.useFakeTimers()
    try {
      const mockApi = api()
      const platform = new PhilipsAirPlatform(log(), config(['192.0.2.1']), mockApi)
      const configured = cached('Offline', 'stable-device-id', '192.0.2.1')
      const purifier = configured.addService(Service.AirPurifier, 'Offline')
      // A characteristic PhilipsAirAccessory never registers a handler for — e.g. one
      // persisted by an older plugin version, or added when the user renames the
      // accessory in the Home app. It must recover with everything else.
      const orphan = purifier.getCharacteristic(Characteristic.SwingMode)
      orphan.updateValue(Characteristic.SwingMode.SWING_ENABLED)
      platform.configureAccessory(configured)
      fakeDevices.set('192.0.2.1', { error: new Error('offline') })

      mockApi.events.get('didFinishLaunching')!()
      await vi.advanceTimersByTimeAsync(0)
      await expect(orphan.handleGetRequest()).rejects.toBeDefined()

      fakeDevices.set('192.0.2.1', { status: gen3Status() })
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockApi.updated).toEqual([configured])
      await expect(orphan.handleGetRequest()).resolves.toBe(Characteristic.SwingMode.SWING_ENABLED)
      expect(orphan.statusCode).toBe(HAPStatus.SUCCESS)

      mockApi.events.get('shutdown')!()
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the generic profile for a model name that collides with Object.prototype', async () => {
    const mockApi = api()
    const platformLog = log()
    fakeDevices.set('192.0.2.4', { status: gen3Status('constructor') })
    new PhilipsAirPlatform(platformLog, config(['192.0.2.4']), mockApi)

    await launch(mockApi)
    const purifier = mockApi.registered[0]!.getService(Service.AirPurifier)!
    await purifier.getCharacteristic(Characteristic.Active).handleSetRequest(Characteristic.Active.ACTIVE)

    expect(vi.mocked(platformLog.info).mock.calls
      .filter(([message]) => String(message).includes('Unknown model'))).toHaveLength(1)
    expect(fakeClients.get('192.0.2.4')?.setControl).toHaveBeenCalledWith({ [Gen3Key.POWER]: 1 })
  })

  it('logs once and removes cached accessories when no devices are configured', async () => {
    const mockApi = api()
    const platformLog = log()
    const platform = new PhilipsAirPlatform(platformLog, config([]), mockApi)
    const removed = cached('Removed', 'removed-id', '192.0.2.9')
    platform.configureAccessory(removed)

    mockApi.events.get('didFinishLaunching')!()
    await vi.waitFor(() => expect(mockApi.unregistered).toEqual([removed]))

    expect(platformLog.info).toHaveBeenCalledOnce()
    expect(mockApi.registered).toEqual([])
  })

  it('poisons every configured cached accessory before the first probe, not just failed ones', async () => {
    const mockApi = api()
    const platform = new PhilipsAirPlatform(log(), config(['192.0.2.1', '192.0.2.3']), mockApi)
    const later = cached('Bedroom', 'later-id', '192.0.2.3')
    const purifier = later.addService(Service.AirPurifier, 'Bedroom')
    const active = purifier.getCharacteristic(Characteristic.Active)
    active.updateValue(Characteristic.Active.INACTIVE)
    platform.configureAccessory(later)
    // The first device hangs, so probing never reaches 192.0.2.3 — exactly the window
    // where a cached accessory with no handlers silently accepts a write from the Home app.
    fakeDevices.set('192.0.2.1', { status: gen3Status(), connect: new Promise<void>(() => {}) })

    mockApi.events.get('didFinishLaunching')!()
    await new Promise(resolve => setImmediate(resolve))

    expect(fakeClientCreations.has('192.0.2.3')).toBe(false)
    expect(active.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    await expect(active.handleSetRequest(Characteristic.Active.ACTIVE)).rejects.toBeDefined()
    await expect(active.handleGetRequest()).rejects.toBeDefined()

    mockApi.events.get('shutdown')!()
  })

  it('logs instead of crashing when a prune throws on the startup path', async () => {
    const mockApi = api()
    const platformLog = log()
    vi.mocked(mockApi.unregisterPlatformAccessories).mockImplementation(() => {
      throw new Error('unregister exploded')
    })
    const platform = new PhilipsAirPlatform(platformLog, config([]), mockApi)
    platform.configureAccessory(cached('Removed', 'removed-id', '192.0.2.9'))

    // An unhandled rejection here terminates Node 22/24, taking Homebridge with it.
    mockApi.events.get('didFinishLaunching')!()
    await vi.waitFor(() => expect(platformLog.error).toHaveBeenCalledWith(
      expect.stringContaining('unregister exploded'),
    ))
  })

  it('logs an unknown model once and controls it with the detected generation', async () => {
    const mockApi = api()
    const platformLog = log()
    fakeDevices.set('192.0.2.3', { status: gen3Status('NEW9999/00') })
    new PhilipsAirPlatform(platformLog, config(['192.0.2.3']), mockApi)

    await launch(mockApi)
    const purifier = mockApi.registered[0]!.getService(Service.AirPurifier)!
    await purifier.getCharacteristic(Characteristic.Active).handleSetRequest(Characteristic.Active.ACTIVE)

    const unknownLogs = vi.mocked(platformLog.info).mock.calls
      .filter(([message]) => String(message).includes('Unknown model'))
    expect(unknownLogs).toHaveLength(1)
    expect(unknownLogs[0]?.[0]).toContain('gen3')
    expect(fakeClients.get('192.0.2.3')?.setControl).toHaveBeenCalledWith({ [Gen3Key.POWER]: 1 })
  })

  it('shuts down every coordinator', async () => {
    const mockApi = api()
    fakeDevices.set('192.0.2.1', { status: gen3Status() })
    fakeDevices.set('192.0.2.2', {
      status: { ...gen3Status(), [Gen1Key.DEVICE_ID]: 'second-device-id' },
    })
    new PhilipsAirPlatform(log(), config(['192.0.2.1', '192.0.2.2']), mockApi)

    mockApi.events.get('didFinishLaunching')!()
    await vi.waitFor(() => expect(mockApi.registered).toHaveLength(2))
    mockApi.events.get('shutdown')!()

    expect(fakeClients.get('192.0.2.1')?.close).toHaveBeenCalledOnce()
    expect(fakeClients.get('192.0.2.2')?.close).toHaveBeenCalledOnce()
  })

  it('does not resume discovery after shutdown interrupts an in-flight startup', async () => {
    const mockApi = api()
    let resolveConnect!: () => void
    const connect = new Promise<void>(resolve => {
      resolveConnect = resolve
    })
    fakeDevices.set('192.0.2.1', { status: gen3Status(), connect })
    fakeDevices.set('192.0.2.2', {
      status: { ...gen3Status(), [Gen1Key.DEVICE_ID]: 'second-device-id' },
    })
    const platform = new PhilipsAirPlatform(log(), config(['192.0.2.1', '192.0.2.2']), mockApi)

    mockApi.events.get('didFinishLaunching')!()
    await vi.waitFor(() => expect(fakeClients.has('192.0.2.1')).toBe(true))
    mockApi.events.get('shutdown')!()
    resolveConnect()
    await new Promise(resolve => setImmediate(resolve))

    expect(mockApi.registered).toEqual([])
    expect(fakeClients.get('192.0.2.1')?.close).toHaveBeenCalledOnce()
    expect(fakeClientCreations.has('192.0.2.2')).toBe(false)
    expect((platform as unknown as { coordinators: Set<unknown> }).coordinators).toHaveLength(0)
  })

  it('sets up a configured host only once', async () => {
    const mockApi = api()
    fakeDevices.set('192.0.2.1', { status: gen3Status() })
    new PhilipsAirPlatform(log(), config(['192.0.2.1', '192.0.2.1']), mockApi)

    mockApi.events.get('didFinishLaunching')!()
    await new Promise(resolve => setImmediate(resolve))

    expect(fakeClientCreations.get('192.0.2.1')).toBe(1)
    expect(mockApi.registered).toHaveLength(1)
  })

  it('keeps a cached accessory poisoned when it wins a retry but loses the duplicate-id claim', async () => {
    vi.useFakeTimers()
    try {
      const mockApi = api()
      const platformLog = log()
      const platform = new PhilipsAirPlatform(platformLog, config(['192.0.2.1', '192.0.2.2']), mockApi)
      const configured = cached('Second', 'second-placeholder', '192.0.2.2')
      const service = configured.addService(Service.AirPurifier, 'Second')
      service.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE)
      platform.configureAccessory(configured)

      // Host 1 connects cleanly first and claims the shared device id.
      fakeDevices.set('192.0.2.1', { status: gen3Status() })
      // Host 2 fails its first connect, poisoning its cached accessory...
      fakeDevices.set('192.0.2.2', { error: new Error('offline') })

      mockApi.events.get('didFinishLaunching')!()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockApi.registered).toHaveLength(1)
      const active = service.getCharacteristic(Characteristic.Active)
      expect(active.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)

      // ...then host 2 connects successfully but reports the same device id as host 1.
      fakeDevices.set('192.0.2.2', { status: gen3Status() })
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(0)

      // The duplicate is discarded, not registered, and the cached accessory must still
      // read "No Response" instead of serving its restored (now stale) pre-offline values.
      expect(mockApi.registered).toHaveLength(1)
      expect(vi.mocked(platformLog.warn).mock.calls.map(([m]) => String(m))
        .some(m => m.includes('192.0.2.2') && m.includes('192.0.2.1'))).toBe(true)
      expect(active.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
      await expect(active.handleGetRequest()).rejects.toBeDefined()
      await expect(active.handleSetRequest(Characteristic.Active.INACTIVE)).rejects.toBeDefined()

      mockApi.events.get('shutdown')!()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-poisons a cached accessory when setting it up throws after clearOffline', async () => {
    vi.useFakeTimers()
    try {
      const mockApi = api()
      const platformLog = log()
      const platform = new PhilipsAirPlatform(platformLog, config(['192.0.2.1']), mockApi)
      const configured = cached('Broken', 'stable-device-id', '192.0.2.1')
      const service = configured.addService(Service.AirPurifier, 'Broken')
      service.getCharacteristic(Characteristic.Active).updateValue(Characteristic.Active.ACTIVE)
      platform.configureAccessory(configured)

      // Poison it via a first-contact failure...
      fakeDevices.set('192.0.2.1', { error: new Error('offline') })
      mockApi.events.get('didFinishLaunching')!()
      await vi.advanceTimersByTimeAsync(0)
      const active = service.getCharacteristic(Characteristic.Active)
      expect(active.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)

      // ...then let it connect, but make the rest of setup blow up (e.g. a HAP-side
      // failure registering the restored accessory) after clearOffline already ran.
      vi.mocked(mockApi.updatePlatformAccessories).mockImplementationOnce(() => {
        throw new Error('boom')
      })
      fakeDevices.set('192.0.2.1', { status: gen3Status() })
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockApi.registered).toEqual([])
      expect(vi.mocked(platformLog.error).mock.calls.map(([m]) => String(m))
        .some(m => m.includes('Failed to set up device'))).toBe(true)
      // Setup blew up after clearOffline ran: the accessory must be re-poisoned, not left
      // frozen on its restored (stale) pre-offline values with no handlers at all.
      expect(active.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
      await expect(active.handleGetRequest()).rejects.toBeDefined()
      await expect(active.handleSetRequest(Characteristic.Active.INACTIVE)).rejects.toBeDefined()

      mockApi.events.get('shutdown')!()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up a second host that resolves to an already configured device id', async () => {
    const mockApi = api()
    const platformLog = log()
    fakeDevices.set('192.0.2.1', { status: gen3Status() })
    fakeDevices.set('192.0.2.2', { status: gen3Status() })
    new PhilipsAirPlatform(platformLog, config(['192.0.2.1', '192.0.2.2']), mockApi)

    mockApi.events.get('didFinishLaunching')!()
    await new Promise(resolve => setImmediate(resolve))

    expect(mockApi.registered).toHaveLength(1)
    // The discarded device must say so: silently dropping it makes a configured
    // device look like it simply never appeared.
    const warnings = vi.mocked(platformLog.warn).mock.calls.map(([message]) => String(message))
    expect(warnings.filter(message =>
      message.includes('192.0.2.2') && message.includes('192.0.2.1'))).toHaveLength(1)
    expect(fakeClients.get('192.0.2.1')?.close).not.toHaveBeenCalled()
    expect(fakeClients.get('192.0.2.2')?.close).toHaveBeenCalledOnce()
  })
})
