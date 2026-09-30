import type {
  API,
  Characteristic as HapCharacteristic,
  CharacteristicValue,
  DynamicPlatformPlugin,
  Logging,
  Nullable,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge'
import { PhilipsAirAccessory } from './accessory.js'
import { PhilipsCoapClient } from './airctrl/client.js'
import { PluginConfigSchema, type DeviceConfig, type DeviceStatus } from './airctrl/schema.js'
import { DeviceCoordinator } from './device/coordinator.js'
import { Gen1Key, Gen2Key, Gen3Key } from './device/keys.js'
import { detectGeneration, findModel, resolveModel } from './device/models.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

/** Stable seed for the accessory UUID: device id if known, else host. */
export function accessoryUuidSeed(
  device: Pick<DeviceConfig, 'host'>,
  deviceId: string | undefined,
): string {
  return deviceId ?? device.host
}

/** Cached accessories no longer represented in the config. */
export function devicesToPrune<T extends { UUID: string }>(cached: T[], configured: Set<string>): T[] {
  return cached.filter(accessory => !configured.has(accessory.UUID))
}

function firstString(status: DeviceStatus, keys: string[]): string | undefined {
  return keys.map(key => status[key]).find(value => typeof value === 'string' && value.length > 0) as
    string | undefined
}

export class PhilipsAirPlatform implements DynamicPlatformPlugin {
  readonly Service: API['hap']['Service']
  readonly Characteristic: API['hap']['Characteristic']
  private readonly cached: PlatformAccessory[] = []
  private readonly coordinators = new Set<DeviceCoordinator>()
  /** Accessory UUID -> owning device host, so a retrying device keeps its accessory. */
  private readonly claimed = new Map<string, string>()
  /** Host -> characteristics {@link markOffline} poisoned, so {@link attach} can undo all of them. */
  private readonly offlined = new Map<string, {
    characteristic: HapCharacteristic
    value: Nullable<CharacteristicValue>
  }[]>()
  private shuttingDown = false

  constructor(
    readonly log: Logging,
    readonly config: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic
    api.on('didFinishLaunching', () => {
      // An unhandled rejection here would take Homebridge down on Node 22/24.
      this.discoverDevices().catch(error => {
        this.log.error(`Device discovery failed: ${String(error)}`)
      })
    })
    api.on('shutdown', () => this.shutdown())
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory ${accessory.displayName}`)
    this.cached.push(accessory)
  }

  private async discoverDevices(): Promise<void> {
    if (this.shuttingDown) return
    const parsed = PluginConfigSchema.safeParse(this.config)
    if (!parsed.success) {
      this.log.error(`Invalid plugin configuration, doing nothing: ${parsed.error.message}`)
      return
    }

    const devices = parsed.data.devices
    if (devices.length === 0) {
      this.log.info('No devices configured. Add one in the Homebridge UI to get started.')
      this.unregister([...this.cached])
      return
    }

    // Probing is sequential and each device costs up to ~16s, so a cached accessory for a
    // later device would sit with no onGet/onSet at all for tens of seconds — long enough
    // for the Home app to accept a write that never reaches the device. Poison them all up
    // front; attach() calls clearOffline() as soon as a device actually answers.
    // ponytail: sequential probe kept deliberately — the duplicate-UUID claim logic is
    // order-sensitive. Revisit with Promise.allSettled if startup latency matters.
    for (const device of devices) this.markOffline(device)

    const seenHosts = new Set<string>()
    for (const device of devices) {
      if (this.shuttingDown) break
      if (seenHosts.has(device.host)) continue
      seenHosts.add(device.host)
      // A single bad device must never take the platform down.
      try {
        await this.setUpDevice(device)
      } catch (error) {
        this.log.error(`Failed to set up device at ${device.host}: ${String(error)}`)
      }
    }
    if (this.shuttingDown) return
    this.unregister(devicesToPrune(this.cached, new Set(this.claimed.keys())))
  }

  private async setUpDevice(device: DeviceConfig): Promise<void> {
    if (this.shuttingDown) return
    const makeClient = async (): Promise<PhilipsCoapClient> =>
      new PhilipsCoapClient(device.host, device.port)
    const coordinator = new DeviceCoordinator(
      new PhilipsCoapClient(device.host, device.port),
      this.log,
      device.host,
      makeClient,
    )
    this.coordinators.add(coordinator)

    try {
      await coordinator.start()
      if (!coordinator.status) {
        this.log.info(`${device.host} connected; waiting for its first status update`)
        coordinator.once('status', () => this.attach(device, coordinator))
        return
      }
    } catch (error) {
      if (this.shuttingDown) {
        this.discard(coordinator)
        return
      }
      // CoAP NON carries no retransmission, so a first-contact failure is routine. Keep the
      // device and let the coordinator's backoff bring it back without a Homebridge restart.
      this.log.error(`Failed to reach device at ${device.host}: ${String(error)}; retrying`)
      this.markOffline(device)
      coordinator.once('status', () => this.attach(device, coordinator))
      coordinator.retryStart()
      return
    }
    this.attach(device, coordinator)
  }

  /** Wire a real accessory once the device has actually reported status. */
  private attach(device: DeviceConfig, coordinator: DeviceCoordinator): void {
    if (this.shuttingDown) {
      this.discard(coordinator)
      return
    }
    const status = coordinator.status
    if (!status) return
    try {
      const deviceId = firstString(status, [Gen1Key.DEVICE_ID, Gen3Key.SERIAL, 'device_id'])
      const modelId = firstString(status, [Gen3Key.MODEL_ID, Gen2Key.MODEL_ID, Gen1Key.MODEL_ID]) ?? ''
      const generation = detectGeneration(status)
      const knownModel = findModel(modelId)
      const model = knownModel ?? resolveModel(modelId, generation)
      if (!knownModel) {
        this.log.info(`Unknown model ${modelId || '(unreported)'}; using generic ${generation} profile`)
      }

      const accessoryUuid = this.api.hap.uuid.generate(accessoryUuidSeed(device, deviceId))
      if (!this.claim(accessoryUuid, device.host)) {
        this.log.warn(
          `Ignoring ${device.host}: it reports the same device id as ${this.claimed.get(accessoryUuid)}`
          + ` (accessory ${accessoryUuid}). Remove the duplicate entry from your config.`,
        )
        this.discard(coordinator)
        return
      }
      const displayName = device.name
        || firstString(status, [Gen3Key.NAME, Gen2Key.NAME, Gen1Key.NAME])
        || modelId
        || device.host
      const existing = this.cached.find(accessory => accessory.UUID === accessoryUuid)
      const accessory = existing ?? new this.api.platformAccessory(displayName, accessoryUuid)
      accessory.displayName = displayName
      accessory.context.device = device
      // Undo markOffline() for every characteristic it touched, not just the ones
      // PhilipsAirAccessory happens to re-register below. Deferred until after the
      // claim check so a duplicate-id device never un-poisons a cached accessory it's
      // about to abandon.
      this.clearOffline(device.host)
      new PhilipsAirAccessory(this, accessory, coordinator, model, device)

      if (existing) {
        this.api.updatePlatformAccessories([existing])
        this.log.info(`Restored ${displayName} (${modelId || 'unknown model'}) at ${device.host}`)
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
        this.log.info(`Added ${displayName} (${modelId || 'unknown model'}) at ${device.host}`)
      }
      this.dropStaleClaims(device.host, accessoryUuid)
    } catch (error) {
      this.log.error(`Failed to set up device at ${device.host}: ${String(error)}`)
      this.markOffline(device)
      this.discard(coordinator)
    }
  }

  /** Reserve a UUID for a host; false if another host already owns it. */
  private claim(uuid: string, host: string): boolean {
    const owner = this.claimed.get(uuid)
    if (owner !== undefined && owner !== host) return false
    this.claimed.set(uuid, host)
    return true
  }

  /** Drop a placeholder accessory reserved for this host before its real device id was known. */
  private dropStaleClaims(host: string, keep: string): void {
    for (const [uuid, owner] of this.claimed) {
      if (owner !== host || uuid === keep) continue
      this.claimed.delete(uuid)
      this.unregister(this.cached.filter(accessory => accessory.UUID === uuid))
    }
  }

  /**
   * A cached accessory with no handlers serves stale values and swallows writes. Surface it as
   * "No Response" until the device answers and {@link attach} installs the real handlers.
   */
  private markOffline(device: DeviceConfig): void {
    const accessory = this.cached.find(entry => entry.context.device?.host === device.host)
    if (!accessory) return
    this.claim(accessory.UUID, device.host)
    const failure = (): Error => new this.api.hap.HapStatusError(
      this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    )
    const poisoned = this.offlined.get(device.host) ?? []
    for (const service of accessory.services) {
      if (service.UUID === this.Service.AccessoryInformation.UUID) continue
      for (const characteristic of service.characteristics) {
        if (characteristic.UUID === this.Characteristic.Name.UUID) continue
        if (!poisoned.some(entry => entry.characteristic === characteristic)) {
          poisoned.push({ characteristic, value: characteristic.value })
        }
        characteristic.onGet(() => {
          throw failure()
        })
        characteristic.onSet(() => {
          throw failure()
        })
        characteristic.updateValue(failure())
      }
    }
    this.offlined.set(device.host, poisoned)
  }

  /** Drop the throwing handlers {@link markOffline} installed and restore the pre-offline values. */
  private clearOffline(host: string): void {
    const poisoned = this.offlined.get(host)
    if (!poisoned) return
    this.offlined.delete(host)
    for (const { characteristic, value } of poisoned) {
      characteristic.removeOnGet()
      characteristic.removeOnSet()
      characteristic.updateValue(value)
    }
  }

  private discard(coordinator: DeviceCoordinator): void {
    coordinator.shutdown()
    this.coordinators.delete(coordinator)
  }

  private unregister(accessories: PlatformAccessory[]): void {
    if (accessories.length === 0) return
    for (const accessory of accessories) {
      const index = this.cached.indexOf(accessory)
      if (index !== -1) this.cached.splice(index, 1)
    }
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories)
  }

  private shutdown(): void {
    this.shuttingDown = true
    for (const coordinator of this.coordinators) coordinator.shutdown()
    this.coordinators.clear()
  }
}
