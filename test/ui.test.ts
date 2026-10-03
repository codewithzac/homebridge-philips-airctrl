import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { RequestError } from '@homebridge/plugin-ui-utils'
import { capabilitiesRequest, probeRequest, scanRequest } from '../homebridge-ui/server.js'
import { hostsInSubnet, localSubnets } from '../src/airctrl/discovery.js'
import {
  addDeviceToConfig,
  createConfigMutator,
  deviceTitle,
  ensureConfig,
  removeDeviceFromConfig,
  setDeviceToggle,
} from '../homebridge-ui/public/config-ops.js'

const root = new URL('../', import.meta.url)

describe('custom UI server', () => {
  it('rejects invalid IPv4 addresses before probing', async () => {
    const probe = vi.fn()

    await expect(probeRequest({ host: '192.168.1.999' }, { probeHost: probe })).rejects.toMatchObject({
      constructor: RequestError,
      message: '"192.168.1.999" is not a valid IPv4 address.',
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('reports a clear error when the host is not a supported Philips device', async () => {
    await expect(
      probeRequest({ host: '192.168.1.20' }, { probeHost: vi.fn().mockResolvedValue(null) }),
    ).rejects.toMatchObject({
      constructor: RequestError,
      message: 'No supported Philips device answered at 192.168.1.20. Check the IP and that the device is on this network.',
    })
  })

  it('rejects an out-of-range port before probing', async () => {
    const probe = vi.fn()

    await expect(probeRequest({ host: '192.168.1.20', port: 70000 }, { probeHost: probe })).rejects.toMatchObject({
      constructor: RequestError,
      message: '"70000" is not a valid port.',
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('converts probe failures to user-facing request errors', async () => {
    await expect(probeRequest(
      { host: '192.168.1.20' },
      { probeHost: vi.fn().mockRejectedValue(new Error('socket failure')) },
    )).rejects.toBeInstanceOf(RequestError)
  })

  it('refuses oversized subnets before discovery starts', async () => {
    const discover = vi.fn()

    await expect(scanRequest(
      { subnet: '10.0.0.0/21' },
      { discover, hostsInSubnet, localSubnets },
    )).rejects.toBeInstanceOf(RequestError)
    expect(discover).not.toHaveBeenCalled()
  })

  it('reports model-driven Natural Breeze capability', async () => {
    const findModel = vi.fn(model => model.startsWith('CX3550')
      ? { naturalSwitch: true }
      : { naturalSwitch: false })

    await expect(capabilitiesRequest(
      { model: 'CX3550/01' },
      { findModel },
    )).resolves.toEqual({ naturalSwitch: true })
    await expect(capabilitiesRequest(
      { model: 'AC4220/12' },
      { findModel },
    )).resolves.toEqual({ naturalSwitch: false })
  })

  it('returns the discovered identity fields unchanged', async () => {
    const device = {
      host: '192.168.1.20',
      model: 'AC4220/12',
      name: 'Office',
      firmware: '0.2.3',
    }
    const result = await scanRequest(
      { subnet: '192.168.1.0/30' },
      { discover: vi.fn().mockResolvedValue([device]), hostsInSubnet, localSubnets },
    )

    expect(result.devices).toEqual([device])
  })

  it('scans every usable subnet on a multi-homed host instead of failing on the first', async () => {
    // Real target: br0 192.168.20.0/24, a Docker bridge 172.18.0.0/16, shim-br0.
    // Taking only localSubnets()[0] made the whole scan fatal whenever the /16 sorted first.
    const discover = vi.fn().mockResolvedValue([])

    const result = await scanRequest({}, {
      discover,
      hostsInSubnet,
      localSubnets: () => ['172.18.0.0/16', '192.168.20.0/30'],
    })

    expect(discover).toHaveBeenCalledTimes(1)
    expect(discover.mock.calls[0]?.[0].hosts).toEqual(['192.168.20.1', '192.168.20.2'])
    expect(result.subnet).toBe('192.168.20.0/30')
    expect(result.scanned).toBe(2)
  })

  it('still errors when no detected subnet is small enough to scan', async () => {
    const discover = vi.fn()

    await expect(scanRequest({}, {
      discover,
      hostsInSubnet,
      localSubnets: () => ['172.18.0.0/16', '10.0.0.0/12'],
    })).rejects.toMatchObject({
      constructor: RequestError,
      message: expect.stringContaining('172.18.0.0/16'),
    })
    expect(discover).not.toHaveBeenCalled()
  })

  it('converts subnet detection failures to request errors', async () => {
    await expect(scanRequest({}, {
      discover: vi.fn(),
      hostsInSubnet,
      localSubnets: () => {
        throw new Error('interface failure')
      },
    })).rejects.toBeInstanceOf(RequestError)
  })

  it('converts discovery failures to request errors', async () => {
    await expect(scanRequest({}, {
      discover: vi.fn().mockRejectedValue(new Error('scan failure')),
      hostsInSubnet,
      localSubnets: () => ['192.168.1.0/30'],
    })).rejects.toBeInstanceOf(RequestError)
  })
})

describe('config-ops (browser config logic)', () => {
  it('ensureConfig creates the platform block and devices array when missing', () => {
    const blocks: any[] = []
    const result = ensureConfig(blocks)
    expect(result).toBe(blocks)
    expect(blocks).toEqual([{ platform: 'PhilipsAirPurifier', name: 'Philips Air Purifier', devices: [] }])
  })

  it('ensureConfig normalizes a non-array devices field', () => {
    const blocks: any[] = [{ platform: 'PhilipsAirPurifier', name: 'Philips Air Purifier' }]
    ensureConfig(blocks)
    expect(blocks[0].devices).toEqual([])
  })

  it('deviceTitle prefers name, then model, then host', () => {
    expect(deviceTitle({ host: 'h', model: 'm', name: 'n' })).toBe('n')
    expect(deviceTitle({ host: 'h', model: 'm' })).toBe('m')
    expect(deviceTitle({ host: 'h' })).toBe('h')
  })

  it('addDeviceToConfig adds a new device with default toggles', () => {
    const blocks = ensureConfig([])
    const added = addDeviceToConfig(blocks, { host: '192.168.1.20', model: 'AC4220/12', name: 'Office' })
    expect(added).toBe(true)
    expect(blocks[0]!.devices).toEqual([{
      host: '192.168.1.20',
      name: 'Office',
      model: 'AC4220/12',
      exposeLight: true,
      exposeSleepSwitch: false,
      exposeNaturalSwitch: false,
      exposeAutoPlusSwitch: false,
      exposeBeepSwitch: false,
    }])
  })

  it('addDeviceToConfig refuses a duplicate host', () => {
    const blocks = ensureConfig([])
    addDeviceToConfig(blocks, { host: '192.168.1.20', model: 'AC4220/12' })
    const added = addDeviceToConfig(blocks, { host: '192.168.1.20', model: 'AC4220/12', name: 'Duplicate' })
    expect(added).toBe(false)
    expect(blocks[0]!.devices).toHaveLength(1)
  })

  it('removeDeviceFromConfig removes a configured device and reports success', () => {
    const blocks = ensureConfig([])
    addDeviceToConfig(blocks, { host: '192.168.1.20', model: 'AC4220/12' })
    const removed = removeDeviceFromConfig(blocks, '192.168.1.20')
    expect(removed).toBe(true)
    expect(blocks[0]!.devices).toHaveLength(0)
  })

  it('removeDeviceFromConfig reports failure for an unknown host', () => {
    const blocks = ensureConfig([])
    expect(removeDeviceFromConfig(blocks, '192.168.1.20')).toBe(false)
  })

  it('setDeviceToggle flips a per-device toggle', () => {
    const blocks = ensureConfig([])
    addDeviceToConfig(blocks, { host: '192.168.1.20', model: 'AC4220/12' })
    setDeviceToggle(blocks, '192.168.1.20', 'exposeSleepSwitch', true)
    expect(blocks[0]!.devices[0]!.exposeSleepSwitch).toBe(true)
  })

  it('setDeviceToggle throws for a host that is no longer configured', () => {
    const blocks = ensureConfig([])
    expect(() => setDeviceToggle(blocks, '192.168.1.20', 'exposeSleepSwitch', true))
      .toThrow('192.168.1.20 is no longer configured.')
  })

  it('createConfigMutator serializes concurrent mutations against a shared store', async () => {
    let stored: any[] = [{ platform: 'PhilipsAirPurifier', name: 'Philips Air Purifier', devices: [] }]
    const loadCalls: number[] = []
    let loadSequence = 0

    const load = vi.fn(async () => {
      const id = ++loadSequence
      loadCalls.push(id)
      // Simulate the async round-trip to the homebridge UI host getting config.
      await new Promise(resolve => setTimeout(resolve, 5))
      return JSON.parse(JSON.stringify(stored))
    })
    const save = vi.fn(async (blocks: any[]) => {
      await new Promise(resolve => setTimeout(resolve, 5))
      stored = blocks
    })

    const mutateConfig = createConfigMutator(load, save)

    const [addedA, addedB] = await Promise.all([
      mutateConfig(blocks => addDeviceToConfig(blocks, { host: '10.0.0.1', model: 'A' })),
      mutateConfig(blocks => addDeviceToConfig(blocks, { host: '10.0.0.2', model: 'B' })),
    ])

    expect(addedA).toBe(true)
    expect(addedB).toBe(true)
    // Both devices must be present: had the two mutations raced against a
    // stale read, the second save would have clobbered the first.
    expect(stored[0].devices.map((d: any) => d.host).sort()).toEqual(['10.0.0.1', '10.0.0.2'])
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('createConfigMutator keeps later mutations running after an earlier one throws', async () => {
    let stored: any[] = [{ platform: 'PhilipsAirPurifier', name: 'Philips Air Purifier', devices: [] }]
    const load = vi.fn(async () => JSON.parse(JSON.stringify(stored)))
    const save = vi.fn(async (blocks: any[]) => {
      stored = blocks
    })
    const mutateConfig = createConfigMutator(load, save)

    await expect(mutateConfig(() => {
      throw new Error('boom')
    })).rejects.toThrow('boom')

    const added = await mutateConfig(blocks => addDeviceToConfig(blocks, { host: '10.0.0.1', model: 'A' }))
    expect(added).toBe(true)
    expect(stored[0].devices).toHaveLength(1)
  })
})

describe('custom UI package', () => {
  it('declares the exact Homebridge platform metadata and service toggles', async () => {
    const schema = JSON.parse(await readFile(new URL('config.schema.json', root), 'utf8'))

    // `customUi: true` is the flag config-ui-x actually gates on:
    //   const s = plugin.settingsSchema ? configSchema : undefined
    //   if (s && s.customUi) return openCustomSettingsUi(...)
    // Without it the custom panel is silently ignored and the generated schema
    // form is rendered instead — no error, no log, just the wrong UI. An
    // earlier version of this test asserted only `customUiPath`, which config-ui-x
    // reads *after* that gate, so the whole custom UI shipped disabled.
    expect(schema).toMatchObject({
      pluginAlias: 'PhilipsAirPurifier',
      pluginType: 'platform',
      singular: true,
      customUi: true,
      customUiPath: './homebridge-ui',
    })
    expect(Object.keys(schema.schema.properties.devices.items.properties)).toEqual(expect.arrayContaining([
      'exposeLight',
      'exposeSleepSwitch',
      'exposeNaturalSwitch',
      'exposeAutoPlusSwitch',
      'exposeBeepSwitch',
    ]))
  })

  it('uses safe DOM rendering and exposes the required config actions', async () => {
    const html = await readFile(new URL('homebridge-ui/public/index.html', root), 'utf8')

    expect(html).not.toMatch(/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('homebridge.updatePluginConfig')
    expect(html).toContain('homebridge.savePluginConfig')
    expect(html).toContain("homebridge.request('/scan')")
    expect(html).toContain("homebridge.request('/probe'")
    for (const key of [
      'exposeLight',
      'exposeSleepSwitch',
      'exposeNaturalSwitch',
      'exposeAutoPlusSwitch',
      'exposeBeepSwitch',
    ]) expect(html).toContain(key)
  })
})
