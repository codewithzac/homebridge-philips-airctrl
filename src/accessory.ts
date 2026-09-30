import type {
  API,
  Characteristic as HapCharacteristic,
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service as HapService,
} from 'homebridge'
import type { DeviceConfig, DeviceStatus } from './airctrl/schema.js'
import type { DeviceCoordinator } from './device/coordinator.js'
import { Gen1Key, Gen2Key, Gen3Key } from './device/keys.js'
import { ApiGeneration, deviceKey, type DeviceModelConfig, powerValues } from './device/models.js'
import {
  airQualityFromPm25,
  beepFromValue,
  beepValue,
  booleanFromValue,
  booleanValue,
  filterLifePercent,
  modeFromRotationSpeed,
  rotationSpeedFromMode,
  temperatureFromRaw,
} from './homekit/mapping.js'

interface LightControl {
  key: string
  on: string | number
  off: string | number
}

/** The structural slice Task 9's platform supplies. */
export interface PhilipsAirPlatformLike {
  readonly api: API
  readonly log: Logging
  readonly Service: API['hap']['Service']
  readonly Characteristic: API['hap']['Characteristic']
}

export class PhilipsAirAccessory {
  private readonly deviceCharacteristics: HapCharacteristic[] = []
  private readonly purifier: HapService
  private readonly airQuality?: HapService
  private temperature?: HapService
  private humidity?: HapService
  private preFilter?: HapService
  private preFilterKeys?: [string, string]
  private nanoFilter?: HapService
  private nanoFilterKeys?: [string, string]
  private light?: HapService
  private lightControl?: LightControl
  private readonly lightCandidates: LightControl[]
  private sleep?: HapService
  private natural?: HapService
  private autoPlus?: HapService
  private beep?: HapService
  private childLock?: HapCharacteristic
  private lastManualMode = 1

  constructor(
    private readonly platform: PhilipsAirPlatformLike,
    private readonly accessory: PlatformAccessory,
    private readonly coordinator: DeviceCoordinator,
    private readonly model: DeviceModelConfig,
    private readonly config: DeviceConfig,
  ) {
    const S = platform.Service
    const C = platform.Characteristic
    const status = coordinator.status

    const information = accessory.getService(S.AccessoryInformation)!
    information
      .setCharacteristic(C.Manufacturer, 'Philips')
      .setCharacteristic(C.Name, accessory.displayName)

    if (model.serviceType === 'fan') {
      const cachedPurifier = accessory.getService(S.AirPurifier)
      if (cachedPurifier) accessory.removeService(cachedPurifier)
      const cachedAirQuality = accessory.getService(S.AirQualitySensor)
      if (cachedAirQuality) accessory.removeService(cachedAirQuality)
      this.purifier = accessory.getService(S.Fanv2)
        ?? accessory.addService(S.Fanv2, accessory.displayName)
    } else {
      const cachedFan = accessory.getService(S.Fanv2)
      if (cachedFan) accessory.removeService(cachedFan)
      this.purifier = accessory.getService(S.AirPurifier)
        ?? accessory.addService(S.AirPurifier, accessory.displayName)
      this.airQuality = accessory.getService(S.AirQualitySensor)
        ?? accessory.addService(S.AirQualitySensor, `${accessory.displayName} Air Quality`)
      this.purifier.addLinkedService(this.airQuality)
    }
    this.purifier.setPrimaryService()

    const active = this.purifier.getCharacteristic(C.Active)
    const rotationSpeed = this.purifier.getCharacteristic(C.RotationSpeed)
    rotationSpeed.setProps({ minStep: 100 / Math.max(1, Object.keys(model.speeds).length) })

    this.onGet(active, device => this.powered(device)
      ? C.Active.ACTIVE
      : C.Active.INACTIVE)
    active.onSet(value => this.write({
      [this.power.key]: value === C.Active.ACTIVE ? this.power.on : this.power.off,
    }))
    this.onGet(rotationSpeed, device => this.powered(device)
      ? rotationSpeedFromMode(this.speedMode(device), Object.keys(this.model.speeds).length)
      : 0)
    rotationSpeed.onSet(value => {
      if (Number(value) <= 0) return this.write({ [this.power.key]: this.power.off })
      const mode = modeFromRotationSpeed(Number(value), Object.keys(this.model.speeds).length)
      const control = mode === null ? undefined : Object.values(this.model.speeds)[mode - 1]
      if (!control) throw this.communicationError()
      return this.write(control)
    })

    if (model.serviceType === 'purifier') {
      const currentState = this.purifier.getCharacteristic(C.CurrentAirPurifierState)
      const targetState = this.purifier.getCharacteristic(C.TargetAirPurifierState)
      if (!model.presetModes.auto) {
        targetState.setProps({ validValues: [C.TargetAirPurifierState.MANUAL] })
      }
      this.onGet(currentState, device => this.powered(device)
        ? C.CurrentAirPurifierState.PURIFYING_AIR
        : C.CurrentAirPurifierState.INACTIVE)
      this.onGet(targetState, device => this.matchesControl(device, this.model.presetModes.auto)
        ? C.TargetAirPurifierState.AUTO
        : C.TargetAirPurifierState.MANUAL)
      targetState.onSet(value => {
        if (value === C.TargetAirPurifierState.AUTO) {
          const control = this.model.presetModes.auto
          if (!control) throw this.communicationError()
          return this.write(control)
        }
        const control = Object.values(this.model.speeds)[this.lastManualMode - 1]
        if (!control) throw this.communicationError()
        return this.write(control)
      })
    }

    if (model.oscillation) {
      const swing = this.purifier.getCharacteristic(C.SwingMode)
      this.onGet(swing, device => device[model.oscillation!.key] === model.oscillation!.off
        ? C.SwingMode.SWING_DISABLED
        : C.SwingMode.SWING_ENABLED)
      swing.onSet(value => this.write({
        [model.oscillation!.key]: value === C.SwingMode.SWING_ENABLED
          ? model.oscillation!.on
          : model.oscillation!.off,
      }))
    }
    // Capability gating is model-driven, never payload-driven: a partial status report
    // must not permanently drop a service, and must never destroy a cached one (that
    // loses the user's HomeKit room assignments and automations).
    const childLockKey = this.childLockKey
    if (childLockKey) {
      this.childLock = this.purifier.getCharacteristic(C.LockPhysicalControls)
      this.onGet(this.childLock, device => this.childLockFromValue(device[childLockKey])
        ? C.LockPhysicalControls.CONTROL_LOCK_ENABLED
        : C.LockPhysicalControls.CONTROL_LOCK_DISABLED)
      this.childLock.onSet(value => this.write({
        [childLockKey]: this.childLockValue(value === C.LockPhysicalControls.CONTROL_LOCK_ENABLED),
      }))
    } else if (this.purifier.testCharacteristic(C.LockPhysicalControls)) {
      this.purifier.removeCharacteristic(this.purifier.getCharacteristic(C.LockPhysicalControls))
    }

    if (this.airQuality) {
      const pm25 = this.airQuality.getCharacteristic(C.PM2_5Density)
      const airQuality = this.airQuality.getCharacteristic(C.AirQuality)
      this.onGet(pm25, device => this.number(device[this.pm25Key]))
      this.onGet(airQuality, device => airQualityFromPm25(device[this.pm25Key]))
    }

    this.lightCandidates = model.lights
      .map(key => this.lightValues(key))
      .filter((control): control is LightControl => control !== undefined)
    this.syncOptionalServices(status)

    const cachedSleep = accessory.getServiceById(S.Switch, 'sleep')
    if (
      config.exposeSleepSwitch
      && this.model.presetModes.sleep
      && (this.model.presetModes.auto || this.model.restoreManualAfterPreset)
    ) {
      this.sleep = cachedSleep ?? accessory.addService(S.Switch, 'Sleep Mode', 'sleep')
      this.purifier.addLinkedService(this.sleep)
      const on = this.sleep.getCharacteristic(C.On)
      this.onGet(on, device =>
        this.powered(device) && this.matchesControl(device, this.model.presetModes.sleep))
      on.onSet(value => {
        const control = value
          ? this.model.presetModes.sleep
          : this.model.presetModes.auto
            ?? (this.model.restoreManualAfterPreset
              ? Object.values(this.model.speeds)[this.lastManualMode - 1]
              : undefined)
        if (!control) throw this.communicationError()
        return this.write(control)
      })
    } else if (cachedSleep) {
      accessory.removeService(cachedSleep)
    }

    const cachedNatural = accessory.getServiceById(S.Switch, 'natural')
    if (config.exposeNaturalSwitch && this.model.naturalSwitch && this.model.presetModes.natural) {
      this.natural = cachedNatural ?? accessory.addService(S.Switch, 'Natural Breeze', 'natural')
      this.purifier.addLinkedService(this.natural)
      const on = this.natural.getCharacteristic(C.On)
      this.onGet(on, device =>
        this.powered(device) && this.matchesControl(device, this.model.presetModes.natural))
      on.onSet(value => {
        const control = value
          ? this.model.presetModes.natural
          : Object.values(this.model.speeds)[this.lastManualMode - 1]
        if (!control) throw this.communicationError()
        return this.write(control)
      })
    } else if (cachedNatural) {
      accessory.removeService(cachedNatural)
    }

    const cachedAutoPlus = accessory.getServiceById(S.Switch, 'auto-plus')
    if (config.exposeAutoPlusSwitch && model.switches.includes(Gen3Key.AUTO_PLUS_AI)) {
      this.autoPlus = cachedAutoPlus ?? accessory.addService(S.Switch, 'Auto Plus AI', 'auto-plus')
      this.purifier.addLinkedService(this.autoPlus)
      const on = this.autoPlus.getCharacteristic(C.On)
      this.onGet(on, device => booleanFromValue(device[Gen3Key.AUTO_PLUS_AI]))
      on.onSet(value => this.write({ [Gen3Key.AUTO_PLUS_AI]: booleanValue(Boolean(value)) }))
    } else if (cachedAutoPlus) {
      accessory.removeService(cachedAutoPlus)
    }

    const cachedBeep = accessory.getServiceById(S.Switch, 'beep')
    const beepKey = this.beepKey
    // Some models (e.g. AC2729) reuse the same device key for Gen1Key.BEEP and
    // Gen1Key.DISPLAY_BACKLIGHT ('uil'). Binding both a Beep switch and a Lamp
    // bulb to that key makes them fight — toggling one silently flips the other.
    // The light wins; the beep switch is skipped when they collide.
    const beepCollidesWithLight = beepKey !== undefined
      && config.exposeLight
      && this.lightCandidates.some(control => control.key === beepKey)
    if (config.exposeBeepSwitch && beepKey && !beepCollidesWithLight) {
      this.beep = cachedBeep ?? accessory.addService(S.Switch, 'Beep', 'beep')
      this.purifier.addLinkedService(this.beep)
      const on = this.beep.getCharacteristic(C.On)
      this.onGet(on, device => this.beepFromValue(device[beepKey]))
      on.onSet(value => this.write({ [beepKey]: this.beepValue(Boolean(value)) }))
    } else {
      if (cachedBeep) accessory.removeService(cachedBeep)
      if (beepCollidesWithLight) platform.log.debug(
        `Skipping Beep switch: key ${beepKey} is already bound to the Lamp light control`,
      )
    }

    coordinator.on('status', (next: DeviceStatus) => {
      this.syncOptionalServices(next)
      this.updateInformation(next)
      if (coordinator.available) this.updateCharacteristics(next)
    })
    coordinator.on('availability', (available: boolean) => {
      if (!available) this.markUnavailable()
    })

    if (status) this.updateInformation(status)
    if (coordinator.available && status) this.updateCharacteristics(status)
    else this.markUnavailable()
  }

  /**
   * Create the sensor/filter/lamp services this device turns out to have.
   *
   * Runs on every status, not just the first: a partial first report (the device omits
   * keys it has not sampled yet) must not permanently hide a sensor. A cached service is
   * only removed when the *model* lacks the capability — removing one because a single
   * payload was short would throw away the user's room assignments and automations.
   */
  private syncOptionalServices(status: DeviceStatus | null): void {
    const S = this.platform.Service
    const C = this.platform.Characteristic
    const accessory = this.accessory

    if (!this.temperature) {
      const key = this.temperatureKey
      if (!key) this.removeCached(accessory.getService(S.TemperatureSensor))
      else if (status && key in status) {
        this.temperature = accessory.getService(S.TemperatureSensor)
          ?? accessory.addService(S.TemperatureSensor, `${accessory.displayName} Temperature`)
        this.purifier.addLinkedService(this.temperature)
        this.onGet(
          this.temperature.getCharacteristic(C.CurrentTemperature),
          device => this.temperatureValue(device[key]),
        )
      }
    }

    if (!this.humidity) {
      const key = this.humidityKey
      if (!key) this.removeCached(accessory.getService(S.HumiditySensor))
      else if (status && key in status) {
        this.humidity = accessory.getService(S.HumiditySensor)
          ?? accessory.addService(S.HumiditySensor, `${accessory.displayName} Humidity`)
        this.purifier.addLinkedService(this.humidity)
        this.onGet(
          this.humidity.getCharacteristic(C.CurrentRelativeHumidity),
          device => this.number(device[key]),
        )
      }
    }

    if (!this.preFilter) {
      const keys = status ? this.filterKeys(status, 'pre') : undefined
      if (!this.filterSupported('pre')) {
        this.removeCached(accessory.getServiceById(S.FilterMaintenance, 'pre-filter'))
      } else if (keys) {
        this.preFilterKeys = keys
        this.preFilter = accessory.getServiceById(S.FilterMaintenance, 'pre-filter')
          ?? accessory.addService(S.FilterMaintenance, 'Pre-Filter', 'pre-filter')
        this.purifier.addLinkedService(this.preFilter)
        this.wireFilter(this.preFilter, ...keys)
      }
    }

    if (!this.nanoFilter) {
      const keys = status ? this.filterKeys(status, 'nano') : undefined
      if (!this.filterSupported('nano')) {
        this.removeCached(accessory.getServiceById(S.FilterMaintenance, 'nano-protect'))
      } else if (keys) {
        this.nanoFilterKeys = keys
        this.nanoFilter = accessory.getServiceById(S.FilterMaintenance, 'nano-protect')
          ?? accessory.addService(S.FilterMaintenance, 'NanoProtect Filter', 'nano-protect')
        this.purifier.addLinkedService(this.nanoFilter)
        this.wireFilter(this.nanoFilter, ...keys)
      }
    }

    if (!this.light) {
      const control = status
        ? this.lightCandidates.find(candidate => candidate.key in status)
        : undefined
      if (!this.config.exposeLight || this.lightCandidates.length === 0) {
        this.removeCached(accessory.getServiceById(S.Lightbulb, 'lamp'))
      } else if (control) {
        this.lightControl = control
        this.light = accessory.getServiceById(S.Lightbulb, 'lamp')
          ?? accessory.addService(S.Lightbulb, 'Lamp', 'lamp')
        this.purifier.addLinkedService(this.light)
        const on = this.light.getCharacteristic(C.On)
        this.onGet(on, device => device[control.key] !== control.off)
        on.onSet(value => this.write({ [control.key]: value ? control.on : control.off }))
      }
    }
  }

  private removeCached(service: HapService | undefined): void {
    if (service) this.accessory.removeService(service)
  }

  /** Whether the model can have this filter at all — independent of any status payload. */
  private filterSupported(kind: 'pre' | 'nano'): boolean {
    const unavailableKey = kind === 'pre'
      ? Gen1Key.FILTER_NANOPROTECT_PREFILTER
      : Gen1Key.FILTER_NANOPROTECT
    return !this.unavailable(this.model.unavailableFilters, unavailableKey)
  }

  private get power(): ReturnType<typeof powerValues> {
    return powerValues(this.model.apiGeneration)
  }

  private get childLockKey(): string | undefined {
    const key = this.model.apiGeneration === ApiGeneration.Gen3
      ? Gen3Key.CHILD_LOCK
      : this.model.apiGeneration === ApiGeneration.Gen1 ? Gen1Key.CHILD_LOCK : undefined
    return key && this.model.switches.some(value => deviceKey(value) === key) ? key : undefined
  }

  private childLockFromValue(value: unknown): boolean {
    return this.model.apiGeneration === ApiGeneration.Gen1 ? value === true : booleanFromValue(value)
  }

  private childLockValue(value: boolean): boolean | number {
    return this.model.apiGeneration === ApiGeneration.Gen1 ? value : booleanValue(value)
  }

  private get beepKey(): string | undefined {
    const key = this.model.apiGeneration === ApiGeneration.Gen1
      ? Gen1Key.BEEP
      : this.model.apiGeneration === ApiGeneration.Gen3 ? Gen3Key.BEEP : undefined
    return key && this.model.switches.some(value => deviceKey(value) === key) ? key : undefined
  }

  private beepFromValue(value: unknown): boolean {
    return this.model.apiGeneration === ApiGeneration.Gen1 ? value === '1' : beepFromValue(value)
  }

  private beepValue(value: boolean): string | number {
    return this.model.apiGeneration === ApiGeneration.Gen1 ? value ? '1' : '0' : beepValue(value)
  }

  private get pm25Key(): string {
    switch (this.model.apiGeneration) {
      case ApiGeneration.Gen2: return Gen2Key.PM25
      case ApiGeneration.Gen3: return Gen3Key.PM25
      default: return Gen1Key.PM25
    }
  }

  private get temperatureKey(): string | undefined {
    const key = this.model.apiGeneration === ApiGeneration.Gen1
      ? Gen1Key.TEMPERATURE
      : this.model.apiGeneration === ApiGeneration.Gen3 ? Gen3Key.TEMPERATURE : undefined
    return key && !this.unavailable(this.model.unavailableSensors, key) ? key : undefined
  }

  private get humidityKey(): string | undefined {
    const key = this.model.apiGeneration === ApiGeneration.Gen1
      ? Gen1Key.HUMIDITY
      : this.model.apiGeneration === ApiGeneration.Gen3 ? Gen3Key.HUMIDITY : undefined
    return key && !this.unavailable(this.model.unavailableSensors, key) ? key : undefined
  }

  private unavailable(keys: string[], key: string): boolean {
    return keys.some(value => deviceKey(value) === key)
  }

  private filterKeys(status: DeviceStatus, kind: 'pre' | 'nano'): [string, string] | undefined {
    const unavailableKey = kind === 'pre'
      ? Gen1Key.FILTER_NANOPROTECT_PREFILTER
      : Gen1Key.FILTER_NANOPROTECT
    if (this.unavailable(this.model.unavailableFilters, unavailableKey)) return undefined

    const sharedKeys: [string, string] = kind === 'pre'
      ? [Gen1Key.FILTER_NANOPROTECT_PREFILTER, Gen1Key.FILTER_NANOPROTECT_CLEAN_TOTAL]
      : [Gen1Key.FILTER_NANOPROTECT, Gen1Key.FILTER_NANOPROTECT_TOTAL]
    const candidates: [string, string][] = this.model.apiGeneration === ApiGeneration.Gen3
      ? [kind === 'pre'
          ? [Gen3Key.FILTER_PREFILTER, Gen3Key.FILTER_PREFILTER_TOTAL]
          : [Gen3Key.FILTER_NANOPROTECT, Gen3Key.FILTER_NANOPROTECT_TOTAL]]
      : this.model.apiGeneration === ApiGeneration.Gen2
        ? [sharedKeys]
      : this.model.apiGeneration === ApiGeneration.Gen1
        ? kind === 'pre'
          ? [
              sharedKeys,
              [Gen1Key.FILTER_PRE, Gen1Key.FILTER_PRE_TOTAL],
            ]
          : [
              sharedKeys,
              [Gen1Key.FILTER_HEPA, Gen1Key.FILTER_HEPA_TOTAL],
            ]
        : []
    return candidates.find(([remaining, total]) => remaining in status && total in status)
  }

  private lightValues(registryKey: string): {
    key: string
    on: string | number
    off: string | number
  } | undefined {
    const key = deviceKey(registryKey)
    if (key === Gen1Key.DISPLAY_BACKLIGHT) return { key, on: '1', off: '0' }
    if (
      key === Gen1Key.LIGHT_BRIGHTNESS
      || key === Gen2Key.DISPLAY_BACKLIGHT
      || key === Gen3Key.DISPLAY_BACKLIGHT_PRIMARY
    ) return { key, on: 100, off: 0 }
    // Gen3Key.DISPLAY_BACKLIGHT (D03105, any #N variant) is a hardware-verified
    // READ-ONLY status mirror: writes are ACKed and silently discarded. There is
    // no documented on-value for it, so no writable Lightbulb is exposed for a
    // model that only lists this key — see Gen3Key.LAMP_MODE for the real control.
    if (key === Gen3Key.LAMP_MODE) return { key, on: 1, off: 0 }
    return undefined
  }

  private powered(status: DeviceStatus): boolean {
    return status[this.power.key] === this.power.on
  }

  private matchesControl(
    status: DeviceStatus,
    control: Record<string, string | number> | undefined,
  ): boolean {
    if (!control) return false
    const entries = Object.entries(control)
      .filter(([key]) => deviceKey(key) !== this.power.key)
    return entries.length > 0
      && entries.every(([key, value]) => status[deviceKey(key)] === value)
  }

  private speedMode(status: DeviceStatus): number | null {
    const index = Object.values(this.model.speeds)
      .findIndex(control => this.matchesControl(status, control))
    if (index !== -1) return index + 1
    return this.fanSpeedMode(status)
  }

  /**
   * Fallback for modes with no matching speed control (Auto, Sleep, or any preset
   * off the ladder) — derive a RotationSpeed position from the reported fan speed
   * (Gen3Key.FAN_SPEED / D0310D) instead of reporting 0 for a running device.
   * Clamped into [1, speedCount]: an out-of-range code (e.g. Turbo reporting 18 on
   * the hardware-verified AC4220, or a model's special top-speed code) lands on the
   * top rung, which matches — those codes represent the fastest reported state.
   */
  private fanSpeedMode(status: DeviceStatus): number | null {
    if (this.model.apiGeneration !== ApiGeneration.Gen3) return null
    if (this.unavailable(this.model.unavailableSensors, Gen3Key.FAN_SPEED)) return null
    const speedCount = Object.keys(this.model.speeds).length
    if (speedCount < 1) return null
    const reported = status[Gen3Key.FAN_SPEED]
    if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 1) return null
    return Math.min(speedCount, Math.round(reported))
  }

  private number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  private temperatureValue(value: unknown): number {
    return this.model.apiGeneration === ApiGeneration.Gen3
      ? temperatureFromRaw(value)
      : this.number(value)
  }

  private communicationError(): InstanceType<API['hap']['HapStatusError']> {
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    )
  }

  private currentStatus(): DeviceStatus {
    if (!this.coordinator.available || !this.coordinator.status) throw this.communicationError()
    return this.coordinator.status
  }

  private onGet(
    characteristic: HapCharacteristic,
    read: (status: DeviceStatus) => CharacteristicValue,
  ): void {
    this.deviceCharacteristics.push(characteristic)
    characteristic.onGet(() => read(this.currentStatus()))
  }

  private async write(values: Record<string, unknown>): Promise<void> {
    if (!this.coordinator.available) throw this.communicationError()
    try {
      if (!await this.coordinator.setControl(values)) throw this.communicationError()
    } catch (error) {
      if (error instanceof this.platform.api.hap.HapStatusError) throw error
      this.platform.log.error(`Control write failed: ${String(error)}`)
      throw this.communicationError()
    }
  }

  private wireFilter(service: HapService, remainingKey: string, totalKey: string): void {
    const C = this.platform.Characteristic
    this.onGet(
      service.getCharacteristic(C.FilterLifeLevel),
      status => filterLifePercent(status[remainingKey], status[totalKey]),
    )
    this.onGet(
      service.getCharacteristic(C.FilterChangeIndication),
      status => filterLifePercent(status[remainingKey], status[totalKey]) === 0
        ? C.FilterChangeIndication.CHANGE_FILTER
        : C.FilterChangeIndication.FILTER_OK,
    )
  }

  private updateInformation(status: DeviceStatus): void {
    const C = this.platform.Characteristic
    const information = this.accessory.getService(this.platform.Service.AccessoryInformation)!
    const model = status[Gen3Key.MODEL_ID] ?? status[Gen2Key.MODEL_ID] ?? status[Gen1Key.MODEL_ID]
    const serial = status[Gen3Key.SERIAL] ?? status[Gen1Key.DEVICE_ID]
    const firmware = status[Gen3Key.SOFTWARE_VERSION]
      ?? status[Gen2Key.SOFTWARE_VERSION]
      ?? status[Gen1Key.SOFTWARE_VERSION]
    if (typeof model === 'string') this.update(information.getCharacteristic(C.Model), model)
    if (typeof serial === 'string') this.update(information.getCharacteristic(C.SerialNumber), serial)
    if (typeof firmware === 'string') this.update(information.getCharacteristic(C.FirmwareRevision), firmware)
  }

  private updateCharacteristics(status: DeviceStatus): void {
    const C = this.platform.Characteristic
    const speedCount = Object.keys(this.model.speeds).length
    const mode = this.speedMode(status)
    const inRestorablePreset = this.model.restoreManualAfterPreset && (
      this.matchesControl(status, this.model.presetModes.sleep)
      || this.matchesControl(status, this.model.presetModes.natural)
    )
    if (mode !== null && !inRestorablePreset) this.lastManualMode = mode
    const powered = this.powered(status)

    this.update(this.purifier.getCharacteristic(C.Active), powered ? C.Active.ACTIVE : C.Active.INACTIVE)
    if (this.model.serviceType === 'purifier') {
      this.update(
        this.purifier.getCharacteristic(C.CurrentAirPurifierState),
        powered ? C.CurrentAirPurifierState.PURIFYING_AIR : C.CurrentAirPurifierState.INACTIVE,
      )
      this.update(
        this.purifier.getCharacteristic(C.TargetAirPurifierState),
        this.matchesControl(status, this.model.presetModes.auto)
          ? C.TargetAirPurifierState.AUTO
          : C.TargetAirPurifierState.MANUAL,
      )
    }
    this.update(
      this.purifier.getCharacteristic(C.RotationSpeed),
      powered ? rotationSpeedFromMode(mode, speedCount) : 0,
    )
    if (this.childLock && this.childLockKey) this.update(
      this.childLock,
      this.childLockFromValue(status[this.childLockKey])
        ? C.LockPhysicalControls.CONTROL_LOCK_ENABLED
        : C.LockPhysicalControls.CONTROL_LOCK_DISABLED,
    )
    if (this.airQuality) {
      this.update(
        this.airQuality.getCharacteristic(C.PM2_5Density),
        this.number(status[this.pm25Key]),
      )
      this.update(
        this.airQuality.getCharacteristic(C.AirQuality),
        airQualityFromPm25(status[this.pm25Key]),
      )
    }
    if (this.temperature && this.temperatureKey) this.update(
      this.temperature.getCharacteristic(C.CurrentTemperature),
      this.temperatureValue(status[this.temperatureKey]),
    )
    if (this.humidity && this.humidityKey) this.update(
      this.humidity.getCharacteristic(C.CurrentRelativeHumidity),
      this.number(status[this.humidityKey]),
    )
    if (this.preFilter && this.preFilterKeys) this.updateFilter(
      this.preFilter,
      status[this.preFilterKeys[0]],
      status[this.preFilterKeys[1]],
    )
    if (this.nanoFilter && this.nanoFilterKeys) this.updateFilter(
      this.nanoFilter,
      status[this.nanoFilterKeys[0]],
      status[this.nanoFilterKeys[1]],
    )
    if (this.light && this.lightControl) this.update(
      this.light.getCharacteristic(C.On),
      status[this.lightControl.key] !== this.lightControl.off,
    )
    if (this.model.oscillation) this.update(
      this.purifier.getCharacteristic(C.SwingMode),
      status[this.model.oscillation.key] === this.model.oscillation.off
        ? C.SwingMode.SWING_DISABLED
        : C.SwingMode.SWING_ENABLED,
    )
    if (this.sleep) this.update(
      this.sleep.getCharacteristic(C.On),
      powered && this.matchesControl(status, this.model.presetModes.sleep),
    )
    if (this.natural) this.update(
      this.natural.getCharacteristic(C.On),
      powered && this.matchesControl(status, this.model.presetModes.natural),
    )
    if (this.autoPlus) this.update(
      this.autoPlus.getCharacteristic(C.On),
      booleanFromValue(status[Gen3Key.AUTO_PLUS_AI]),
    )
    if (this.beep && this.beepKey) this.update(
      this.beep.getCharacteristic(C.On),
      this.beepFromValue(status[this.beepKey]),
    )
  }

  private updateFilter(service: HapService, remaining: unknown, total: unknown): void {
    const C = this.platform.Characteristic
    const life = filterLifePercent(remaining, total)
    this.update(service.getCharacteristic(C.FilterLifeLevel), life)
    this.update(
      service.getCharacteristic(C.FilterChangeIndication),
      life === 0 ? C.FilterChangeIndication.CHANGE_FILTER : C.FilterChangeIndication.FILTER_OK,
    )
  }

  private update(characteristic: HapCharacteristic, value: CharacteristicValue): void {
    if (
      characteristic.value !== value
      || characteristic.statusCode !== this.platform.api.hap.HAPStatus.SUCCESS
    ) characteristic.updateValue(value)
  }

  private markUnavailable(): void {
    for (const characteristic of this.deviceCharacteristics) {
      characteristic.updateValue(this.communicationError())
    }
  }
}
