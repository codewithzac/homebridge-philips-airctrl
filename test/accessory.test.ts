import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { Accessory, Characteristic, HapStatusError, HAPStatus, Service, uuid } from '@homebridge/hap-nodejs'
import type { API, Logging, PlatformAccessory } from 'homebridge'
import { describe, expect, it, vi } from 'vitest'
import { PhilipsAirAccessory, type PhilipsAirPlatformLike } from '../src/accessory.js'
import type { DeviceCoordinator } from '../src/device/coordinator.js'
import { Gen1Key, Gen3Key } from '../src/device/keys.js'
import { resolveModel, type DeviceModelConfig } from '../src/device/models.js'
import type { DeviceConfig, DeviceStatus } from '../src/airctrl/schema.js'

const capturedStatus = JSON.parse(readFileSync(
  new URL('./fixtures/ac4220-12-status.json', import.meta.url),
  'utf8',
)) as DeviceStatus

class FakeCoordinator extends EventEmitter {
  available = true
  status: DeviceStatus | null
  setControl = vi.fn(async (_values: Record<string, unknown>) => true)

  constructor(status: DeviceStatus = capturedStatus) {
    super()
    this.status = { ...status }
  }

  publish(changes: DeviceStatus): void {
    this.status = { ...this.status, ...changes }
    this.emit('status', this.status)
  }

  setAvailable(available: boolean): void {
    this.available = available
    this.emit('availability', available)
  }
}

const deviceConfig: DeviceConfig = {
  host: '192.0.2.1',
  port: 5683,
  exposeSleepSwitch: true,
  exposeNaturalSwitch: true,
  exposeAutoPlusSwitch: true,
  exposeBeepSwitch: true,
  exposeLight: true,
}

function setup(
  config: DeviceConfig = deviceConfig,
  status: DeviceStatus = capturedStatus,
  model: DeviceModelConfig = resolveModel('AC4220/12'),
  accessory: Accessory = new Accessory('Office', uuid.generate('office')),
): {
  accessory: Accessory
  coordinator: FakeCoordinator
  log: Logging & { debug: ReturnType<typeof vi.fn> }
} {
  const coordinator = new FakeCoordinator(status)
  const log = Object.assign(vi.fn(), {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    prefix: '',
  }) as unknown as Logging & { debug: ReturnType<typeof vi.fn> }
  const platform = {
    api: { hap: { HapStatusError, HAPStatus: { SUCCESS: HAPStatus.SUCCESS, SERVICE_COMMUNICATION_FAILURE: HAPStatus.SERVICE_COMMUNICATION_FAILURE } } } as unknown as API,
    log,
    Service,
    Characteristic,
  } as PhilipsAirPlatformLike

  new PhilipsAirAccessory(
    platform,
    accessory as unknown as PlatformAccessory,
    coordinator as unknown as DeviceCoordinator,
    model,
    config,
  )
  return { accessory, coordinator, log }
}

describe('PhilipsAirAccessory', () => {
  it('exposes the AC4220 services and observed accessory information', async () => {
    const { accessory } = setup()
    const purifier = accessory.getService(Service.AirPurifier)!
    const information = accessory.getService(Service.AccessoryInformation)!

    expect(await information.getCharacteristic(Characteristic.Model).handleGetRequest()).toBe('AC4220/12')
    expect(information.getCharacteristic(Characteristic.SerialNumber).value).toBe('688001001527')
    expect(information.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('0.2.3')
    expect(purifier.getCharacteristic(Characteristic.RotationSpeed).props.minStep).toBe(20)
    expect(accessory.getService(Service.AirQualitySensor)).toBeDefined()
    expect(accessory.getService(Service.TemperatureSensor)).toBeDefined()
    expect(accessory.getService(Service.HumiditySensor)).toBeDefined()
    expect(accessory.getServiceById(Service.FilterMaintenance, 'pre-filter')).toBeDefined()
    expect(accessory.getServiceById(Service.FilterMaintenance, 'nano-protect')).toBeDefined()
    expect(accessory.getServiceById(Service.Lightbulb, 'lamp')).toBeDefined()
    expect(accessory.getServiceById(Service.Switch, 'sleep')).toBeDefined()
    expect(accessory.getServiceById(Service.Switch, 'auto-plus')).toBeDefined()
    expect(accessory.getServiceById(Service.Switch, 'beep')).toBeDefined()
    expect(purifier.isPrimaryService).toBe(true)
    expect(purifier.linkedServices).toEqual(expect.arrayContaining([
      accessory.getService(Service.AirQualitySensor),
      accessory.getService(Service.TemperatureSensor),
      accessory.getService(Service.HumiditySensor),
      accessory.getServiceById(Service.FilterMaintenance, 'pre-filter'),
      accessory.getServiceById(Service.FilterMaintenance, 'nano-protect'),
      accessory.getServiceById(Service.Lightbulb, 'lamp'),
      accessory.getServiceById(Service.Switch, 'sleep'),
      accessory.getServiceById(Service.Switch, 'auto-plus'),
      accessory.getServiceById(Service.Switch, 'beep'),
    ]))
    expect(purifier.linkedServices).toHaveLength(9)
  })

  it('exposes CX3550 as a native fan with three speeds, modes, and hardware-verified oscillation', async () => {
    const status: DeviceStatus = {
      [Gen3Key.MODEL_ID]: 'CX3550/01',
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_A]: 1,
      [Gen3Key.MODE_B]: 2,
      [Gen3Key.FAN_SPEED]: 2,
      [Gen3Key.OSCILLATION]: 0,
    }
    const { accessory, coordinator } = setup(
      deviceConfig,
      status,
      resolveModel('CX3550/01'),
      new Accessory('Bedroom', uuid.generate('cx3550')),
    )
    const fan = accessory.getService(Service.Fanv2)!

    expect(fan).toBeDefined()
    expect(accessory.getService(Service.AirPurifier)).toBeUndefined()
    expect(accessory.getService(Service.AirQualitySensor)).toBeUndefined()
    expect(fan.isPrimaryService).toBe(true)
    expect(fan.getCharacteristic(Characteristic.RotationSpeed).props.minStep)
      .toBeCloseTo(100 / 3)

    await expect(fan.getCharacteristic(Characteristic.RotationSpeed).handleGetRequest())
      .resolves.toBeCloseTo(200 / 3)
    await fan.getCharacteristic(Characteristic.RotationSpeed).handleSetRequest(100)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_A]: 1,
      [Gen3Key.MODE_B]: 3,
    })

    await expect(fan.getCharacteristic(Characteristic.SwingMode).handleGetRequest())
      .resolves.toBe(Characteristic.SwingMode.SWING_DISABLED)
    await fan.getCharacteristic(Characteristic.SwingMode)
      .handleSetRequest(Characteristic.SwingMode.SWING_ENABLED)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen3Key.OSCILLATION]: 23040 })

    const sleep = accessory.getServiceById(Service.Switch, 'sleep')!
    await sleep.getCharacteristic(Characteristic.On).handleSetRequest(true)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_A]: 1,
      [Gen3Key.MODE_B]: 17,
    })

    coordinator.publish({ [Gen3Key.MODE_B]: 17, [Gen3Key.FAN_SPEED]: 2 })
    await expect(sleep.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(true)
    await sleep.getCharacteristic(Characteristic.On).handleSetRequest(false)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_A]: 1,
      [Gen3Key.MODE_B]: 2,
    })

    const natural = accessory.getServiceById(Service.Switch, 'natural')!
    await natural.getCharacteristic(Characteristic.On).handleSetRequest(true)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_A]: 1,
      [Gen3Key.MODE_B]: -126,
    })

    coordinator.publish({ [Gen3Key.MODE_B]: -126, [Gen3Key.FAN_SPEED]: 2 })
    await expect(natural.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(true)
  })

  it('makes every device-backed read fail with No Response while unavailable', async () => {
    const { accessory, coordinator } = setup()
    const reads = [
      accessory.getService(Service.AirPurifier)!
        .getCharacteristic(Characteristic.Active),
      accessory.getService(Service.AirQualitySensor)!
        .getCharacteristic(Characteristic.PM2_5Density),
      accessory.getService(Service.TemperatureSensor)!
        .getCharacteristic(Characteristic.CurrentTemperature),
      accessory.getServiceById(Service.FilterMaintenance, 'pre-filter')!
        .getCharacteristic(Characteristic.FilterLifeLevel),
      accessory.getServiceById(Service.Lightbulb, 'lamp')!
        .getCharacteristic(Characteristic.On),
      accessory.getServiceById(Service.Switch, 'beep')!
        .getCharacteristic(Characteristic.On),
    ]

    coordinator.setAvailable(false)

    for (const characteristic of reads) {
      await expect(characteristic.handleGetRequest())
        .rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
      expect(characteristic.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  })

  it('uses hardware-correct AC4220 writes without optimistic status mutation', async () => {
    const { accessory, coordinator } = setup()
    const purifier = accessory.getService(Service.AirPurifier)!

    await expect(purifier.getCharacteristic(Characteristic.LockPhysicalControls).handleGetRequest())
      .resolves.toBe(Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED)
    await purifier.getCharacteristic(Characteristic.LockPhysicalControls).handleSetRequest(
      Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED,
    )
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen3Key.CHILD_LOCK]: 1 })

    await purifier.getCharacteristic(Characteristic.RotationSpeed).handleSetRequest(0)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen3Key.POWER]: 0 })

    await purifier.getCharacteristic(Characteristic.TargetAirPurifierState).handleSetRequest(
      Characteristic.TargetAirPurifierState.MANUAL,
    )
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 1,
    })

    coordinator.publish({ [Gen3Key.MODE_B]: 4 })
    await purifier.getCharacteristic(Characteristic.TargetAirPurifierState).handleSetRequest(
      Characteristic.TargetAirPurifierState.MANUAL,
    )
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 4,
    })

    await purifier.getCharacteristic(Characteristic.TargetAirPurifierState).handleSetRequest(
      Characteristic.TargetAirPurifierState.AUTO,
    )
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 0,
    })

    await accessory.getServiceById(Service.Lightbulb, 'lamp')!
      .getCharacteristic(Characteristic.On).handleSetRequest(true)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen3Key.LAMP_MODE]: 1 })

    const beep = accessory.getServiceById(Service.Switch, 'beep')!
      .getCharacteristic(Characteristic.On)
    await expect(beep.handleGetRequest()).resolves.toBe(true)
    await beep.handleSetRequest(true)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen3Key.BEEP]: 100 })

    await accessory.getServiceById(Service.Switch, 'sleep')!
      .getCharacteristic(Characteristic.On).handleSetRequest(false)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 0,
    })
    expect(coordinator.status![Gen3Key.LAMP_MODE]).toBe(0)
    expect(coordinator.status![Gen3Key.BEEP]).toBe(100)
  })

  it('turns failed control ACKs into HomeKit communication failures', async () => {
    const { accessory, coordinator } = setup()
    coordinator.setControl.mockResolvedValueOnce(false)

    await expect(accessory.getServiceById(Service.Lightbulb, 'lamp')!
      .getCharacteristic(Characteristic.On).handleSetRequest(true))
      .rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  })

  it('updates a characteristic at most once per changed status snapshot', () => {
    const { accessory, coordinator } = setup()
    const speed = accessory.getService(Service.AirPurifier)!
      .getCharacteristic(Characteristic.RotationSpeed)
    const update = vi.spyOn(speed, 'updateValue')

    coordinator.publish({ [Gen3Key.MODE_B]: 2 })

    expect(update).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith(40)
  })

  it('waits for a fresh status event and clears No Response even when status is unchanged', () => {
    const { accessory, coordinator } = setup()
    const speed = accessory.getService(Service.AirPurifier)!
      .getCharacteristic(Characteristic.RotationSpeed)
    const update = vi.spyOn(speed, 'updateValue')

    coordinator.setAvailable(false)
    update.mockClear()
    coordinator.setAvailable(true)

    expect(update).not.toHaveBeenCalled()

    coordinator.publish({})
    expect(update).toHaveBeenCalledOnce()
    // The captured fixture is on (D03102=1) in Auto (D0310C=0) reporting fan
    // speed 1 (D0310D=1) — RotationSpeed must reflect that running speed (20%),
    // not 0. (Previously asserted 0 here, which was finding 1's bug: Active
    // reads ACTIVE while RotationSpeed read 0 for the same running device.)
    expect(update).toHaveBeenCalledWith(20)
    expect(speed.statusCode).toBe(HAPStatus.SUCCESS)
  })

  it('reports a nonzero RotationSpeed while Active for Auto mode on the real AC4220 fixture', async () => {
    const { accessory } = setup()
    const purifier = accessory.getService(Service.AirPurifier)!

    await expect(purifier.getCharacteristic(Characteristic.Active).handleGetRequest())
      .resolves.toBe(Characteristic.Active.ACTIVE)
    const speed = await purifier.getCharacteristic(Characteristic.RotationSpeed).handleGetRequest()
    expect(speed).toBeGreaterThan(0)
    expect(speed).toBe(20)
  })

  it('removes disabled optional services restored from cache', () => {
    const accessory = new Accessory('Office', uuid.generate('cached-office'))
    accessory.addService(Service.Lightbulb, 'Lamp', 'lamp')
    accessory.addService(Service.Switch, 'Sleep Mode', 'sleep')
    accessory.addService(Service.Switch, 'Auto Plus AI', 'auto-plus')
    accessory.addService(Service.Switch, 'Beep', 'beep')
    const coordinator = new FakeCoordinator()
    const platform = {
      api: { hap: { HapStatusError, HAPStatus: { SUCCESS: HAPStatus.SUCCESS, SERVICE_COMMUNICATION_FAILURE: HAPStatus.SERVICE_COMMUNICATION_FAILURE } } } as unknown as API,
      log: vi.fn() as unknown as Logging,
      Service,
      Characteristic,
    } as PhilipsAirPlatformLike

    new PhilipsAirAccessory(
      platform,
      accessory as unknown as PlatformAccessory,
      coordinator as unknown as DeviceCoordinator,
      resolveModel('AC4220/12'),
      { ...deviceConfig, exposeLight: false, exposeSleepSwitch: false, exposeAutoPlusSwitch: false, exposeBeepSwitch: false },
    )

    expect(accessory.getServiceById(Service.Lightbulb, 'lamp')).toBeUndefined()
    expect(accessory.getServiceById(Service.Switch, 'sleep')).toBeUndefined()
    expect(accessory.getServiceById(Service.Switch, 'auto-plus')).toBeUndefined()
    expect(accessory.getServiceById(Service.Switch, 'beep')).toBeUndefined()
  })

  it('adds sensors, filters and the lamp when they only appear in a later status report', async () => {
    // A first report that omits keys the device has not sampled yet must not
    // permanently hide those services for the whole process lifetime.
    const { accessory, coordinator } = setup(deviceConfig, {
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 0,
      [Gen3Key.PM25]: 8,
    })

    expect(accessory.getService(Service.TemperatureSensor)).toBeUndefined()
    expect(accessory.getService(Service.HumiditySensor)).toBeUndefined()
    expect(accessory.getServiceById(Service.FilterMaintenance, 'pre-filter')).toBeUndefined()
    expect(accessory.getServiceById(Service.Lightbulb, 'lamp')).toBeUndefined()

    coordinator.publish({
      [Gen3Key.TEMPERATURE]: 215,
      [Gen3Key.HUMIDITY]: 45,
      [Gen3Key.FILTER_PREFILTER]: 100,
      [Gen3Key.FILTER_PREFILTER_TOTAL]: 200,
      [Gen3Key.LAMP_MODE]: 1,
    })

    await expect(accessory.getService(Service.TemperatureSensor)!
      .getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).resolves.toBe(21.5)
    await expect(accessory.getService(Service.HumiditySensor)!
      .getCharacteristic(Characteristic.CurrentRelativeHumidity).handleGetRequest()).resolves.toBe(45)
    await expect(accessory.getServiceById(Service.FilterMaintenance, 'pre-filter')!
      .getCharacteristic(Characteristic.FilterLifeLevel).handleGetRequest()).resolves.toBe(50)

    const light = accessory.getServiceById(Service.Lightbulb, 'lamp')!
    await expect(light.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(true)
    await light.getCharacteristic(Characteristic.On).handleSetRequest(false)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen3Key.LAMP_MODE]: 0 })
  })

  it('never destroys a cached service because one status report was partial', () => {
    // removeService takes the user's HomeKit room assignments and automations with
    // it, so only a model that genuinely lacks the capability may trigger removal.
    const cached = new Accessory('Office', uuid.generate('partial-report'))
    cached.addService(Service.TemperatureSensor, 'Office Temperature')
    cached.addService(Service.HumiditySensor, 'Office Humidity')
    cached.addService(Service.FilterMaintenance, 'Pre-Filter', 'pre-filter')
    cached.addService(Service.FilterMaintenance, 'NanoProtect Filter', 'nano-protect')
    cached.addService(Service.Lightbulb, 'Lamp', 'lamp')

    const { accessory } = setup(deviceConfig, {
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 0,
      [Gen3Key.PM25]: 8,
    }, resolveModel('AC4220/12'), cached)

    expect(accessory.getService(Service.TemperatureSensor)).toBeDefined()
    expect(accessory.getService(Service.HumiditySensor)).toBeDefined()
    expect(accessory.getServiceById(Service.FilterMaintenance, 'pre-filter')).toBeDefined()
    expect(accessory.getServiceById(Service.FilterMaintenance, 'nano-protect')).toBeDefined()
    expect(accessory.getServiceById(Service.Lightbulb, 'lamp')).toBeDefined()
  })

  it('maps Gen1 power, presets, ladder state, sensors, filters, and light from registry keys', async () => {
    const status = {
      pwr: '1',
      mode: 'AG',
      om: 'a',
      pm25: 8,
      temp: 21,
      rh: 45,
      uil: '1',
      'D05-13': 175,
      'D05-07': 720,
      'D05-14': 1374,
      'D05-08': 9600,
    }
    const { accessory, coordinator } = setup(deviceConfig, status, resolveModel('AC3858/50'))
    const purifier = accessory.getService(Service.AirPurifier)!

    await expect(purifier.getCharacteristic(Characteristic.Active).handleGetRequest())
      .resolves.toBe(Characteristic.Active.ACTIVE)
    await expect(purifier.getCharacteristic(Characteristic.TargetAirPurifierState).handleGetRequest())
      .resolves.toBe(Characteristic.TargetAirPurifierState.AUTO)
    await expect(accessory.getService(Service.TemperatureSensor)!
      .getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).resolves.toBe(21)
    await expect(accessory.getService(Service.HumiditySensor)!
      .getCharacteristic(Characteristic.CurrentRelativeHumidity).handleGetRequest()).resolves.toBe(45)
    await expect(accessory.getServiceById(Service.FilterMaintenance, 'pre-filter')!
      .getCharacteristic(Characteristic.FilterLifeLevel).handleGetRequest()).resolves.toBe(24)
    await expect(accessory.getServiceById(Service.FilterMaintenance, 'nano-protect')!
      .getCharacteristic(Characteristic.FilterLifeLevel).handleGetRequest()).resolves.toBe(14)

    const light = accessory.getServiceById(Service.Lightbulb, 'lamp')!
    await expect(light.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(true)
    await light.getCharacteristic(Characteristic.On).handleSetRequest(false)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ uil: '0' })

    coordinator.publish({ mode: 'M', om: '2' })
    await expect(purifier.getCharacteristic(Characteristic.RotationSpeed).handleGetRequest())
      .resolves.toBe(75)
  })

  it('maps Gen1 child lock booleans and drops the colliding Beep switch (AC2729)', async () => {
    // AC2729 lists Gen1Key.BEEP and Gen1Key.DISPLAY_BACKLIGHT as the same device
    // key ('uil') — see keys.ts. Only one service may bind to it: the Lamp wins,
    // the Beep switch is skipped. (Previously this test set up exactly this
    // collision and only asserted the Beep half worked, which encoded the bug:
    // toggling "Beep" silently flipped the "Lamp" bulb too, and vice versa.)
    const { accessory, coordinator, log } = setup(deviceConfig, {
      [Gen1Key.POWER]: '1',
      [Gen1Key.MODE]: 'P',
      [Gen1Key.SPEED]: '1',
      [Gen1Key.PM25]: 8,
      [Gen1Key.CHILD_LOCK]: true,
      [Gen1Key.BEEP]: '1',
    }, resolveModel('AC2729'))
    const childLock = accessory.getService(Service.AirPurifier)!
      .getCharacteristic(Characteristic.LockPhysicalControls)

    await expect(childLock.handleGetRequest())
      .resolves.toBe(Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED)
    await childLock.handleSetRequest(Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen1Key.CHILD_LOCK]: false })
    await childLock.handleSetRequest(Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen1Key.CHILD_LOCK]: true })

    expect(accessory.getServiceById(Service.Switch, 'beep')).toBeUndefined()
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('uil'))

    const light = accessory.getServiceById(Service.Lightbulb, 'lamp')!
    await expect(light.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(true)
    await light.getCharacteristic(Characteristic.On).handleSetRequest(false)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen1Key.DISPLAY_BACKLIGHT]: '0' })
  })

  it('maps Gen2 power, Auto target, and ordered ladder state', async () => {
    const { accessory, coordinator } = setup(deviceConfig, {
      'D03-02': 'ON',
      'D03-12': 'Auto General',
      'D03-33': 8,
      'D03-05': 1,
    }, resolveModel('AC1715'))
    const purifier = accessory.getService(Service.AirPurifier)!

    await expect(purifier.getCharacteristic(Characteristic.Active).handleGetRequest())
      .resolves.toBe(Characteristic.Active.ACTIVE)
    await expect(purifier.getCharacteristic(Characteristic.TargetAirPurifierState).handleGetRequest())
      .resolves.toBe(Characteristic.TargetAirPurifierState.AUTO)

    coordinator.publish({ 'D03-12': 'Speed 2' })
    await expect(purifier.getCharacteristic(Characteristic.RotationSpeed).handleGetRequest())
      .resolves.toBe(75)
  })

  it('exposes only the available Gen2 NanoProtect filter', async () => {
    const { accessory } = setup(deviceConfig, {
      'D03-02': 'ON',
      'D03-12': 'Auto General',
      'D03-33': 8,
      'D05-13': 175,
      'D05-07': 720,
      'D05-14': 1374,
      'D05-08': 9600,
    }, resolveModel('AC0850/11 AWS_Philips_AIR'))

    expect(accessory.getServiceById(Service.FilterMaintenance, 'pre-filter')).toBeUndefined()
    await expect(accessory.getServiceById(Service.FilterMaintenance, 'nano-protect')!
      .getCharacteristic(Characteristic.FilterLifeLevel).handleGetRequest()).resolves.toBe(14)
  })

  it('removes unsupported Gen2 child lock and never writes cl', async () => {
    const cached = new Accessory('Office', uuid.generate('gen2-child-lock'))
    cached.getService(Service.AccessoryInformation)
    cached.addService(Service.AirPurifier, 'Office')
      .getCharacteristic(Characteristic.LockPhysicalControls)
    const { accessory, coordinator } = setup(deviceConfig, {
      'D03-02': 'ON',
      'D03-12': 'Auto General',
      'D03-33': 8,
    }, resolveModel('AC1715'), cached)
    const purifier = accessory.getService(Service.AirPurifier)!

    expect(purifier.testCharacteristic(Characteristic.LockPhysicalControls)).toBe(false)
    await purifier.getCharacteristic(Characteristic.LockPhysicalControls).handleSetRequest(
      Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED,
    )
    expect(coordinator.setControl).not.toHaveBeenCalled()
  })

  it('maps non-ladder Gen3 mode values by ordered model speed writes, and exposes no dead D03105 light', async () => {
    // D03105 (Gen3Key.DISPLAY_BACKLIGHT) is a hardware-verified read-only status
    // mirror (see keys.ts, hardware fact 1). AC0950's registry lists it as the
    // light entity but has no known LAMP_MODE alternative to route through, so
    // no writable Lightbulb is exposed. (Previously this test only asserted the
    // Lightbulb service existed, which encoded the bug: toggling it wrote the
    // undocumented magic value 123 to a key the device ACKs and ignores.)
    const { accessory } = setup(deviceConfig, {
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 19,
      [Gen3Key.PM25]: 8,
      [Gen3Key.DISPLAY_BACKLIGHT]: 1,
      [Gen3Key.FILTER_PREFILTER]: 100,
      [Gen3Key.FILTER_PREFILTER_TOTAL]: 200,
    }, resolveModel('AC0950'))

    await expect(accessory.getService(Service.AirPurifier)!
      .getCharacteristic(Characteristic.RotationSpeed).handleGetRequest())
      .resolves.toBeCloseTo(200 / 3)
    expect(accessory.getServiceById(Service.Lightbulb, 'lamp')).toBeUndefined()
    expect(accessory.getServiceById(Service.FilterMaintenance, 'pre-filter')).toBeUndefined()
  })

  it('routes the AC2221 Lamp through LAMP_MODE (D03135), not the read-only D03105 mirror', async () => {
    const { accessory, coordinator } = setup(deviceConfig, {
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 0,
      [Gen3Key.PM25]: 8,
      [Gen3Key.LAMP_MODE]: 0,
    }, resolveModel('AC2221'))

    const light = accessory.getServiceById(Service.Lightbulb, 'lamp')!
    await expect(light.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(false)
    await light.getCharacteristic(Characteristic.On).handleSetRequest(true)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen3Key.LAMP_MODE]: 1 })
  })

  it('rejects nonzero RotationSpeed when the model has no speed ladder', async () => {
    const { accessory, coordinator } = setup(deviceConfig, {
      pwr: '1',
      pm25: 8,
    }, resolveModel('unknown'))

    await expect(accessory.getService(Service.AirPurifier)!
      .getCharacteristic(Characteristic.RotationSpeed).handleSetRequest(50))
      .rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    expect(coordinator.setControl).not.toHaveBeenCalled()
  })

  it('offers only Manual on a model with no Auto preset', async () => {
    const { accessory } = setup(deviceConfig, {
      pwr: '1',
      pm25: 8,
    }, resolveModel('unknown'))
    const targetState = accessory.getService(Service.AirPurifier)!
      .getCharacteristic(Characteristic.TargetAirPurifierState)

    // TargetAirPurifierState is mandatory, so Home always draws the toggle. Selecting
    // Auto on such a model can only ever error, so Auto must not be a valid value.
    expect(targetState.props.validValues).toEqual([Characteristic.TargetAirPurifierState.MANUAL])
    await expect(targetState.handleGetRequest())
      .resolves.toBe(Characteristic.TargetAirPurifierState.MANUAL)
  })

  it('keeps both Auto and Manual on a model that has an Auto preset', () => {
    const { accessory } = setup()
    const targetState = accessory.getService(Service.AirPurifier)!
      .getCharacteristic(Characteristic.TargetAirPurifierState)

    expect(targetState.props.validValues).toEqual(expect.arrayContaining([
      Characteristic.TargetAirPurifierState.MANUAL,
      Characteristic.TargetAirPurifierState.AUTO,
    ]))
  })

  it('removes cached Sleep when the model has no Auto preset', () => {
    const cached = new Accessory('Office', uuid.generate('no-auto'))
    cached.addService(Service.Switch, 'Sleep Mode', 'sleep')
    const { accessory } = setup(deviceConfig, {
      pwr: '1',
      mode: 'M',
      om: 's',
      pm25: 8,
    }, resolveModel('AC5659'), cached)

    expect(accessory.getServiceById(Service.Switch, 'sleep')).toBeUndefined()
  })
})
