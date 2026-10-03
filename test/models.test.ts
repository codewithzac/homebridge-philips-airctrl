import { describe, expect, it } from 'vitest'
import {
  ApiGeneration,
  detectGeneration,
  DEVICE_MODELS,
  deviceKey,
  powerValues,
  resolveModel,
} from '../src/device/models.js'

describe('deviceKey', () => {
  it.each([
    ['D03105#1', 'D03105'],
    ['D0310A#2', 'D0310A'],
    ['D03102', 'D03102'],
  ])('strips the variant suffix from %s', (input, expected) => {
    expect(deviceKey(input)).toBe(expected)
  })
})

describe('powerValues', () => {
  it.each([
    [ApiGeneration.Gen1, 'pwr', '1', '0'],
    [ApiGeneration.Gen2, 'D03-02', 'ON', 'OFF'],
    [ApiGeneration.Gen3, 'D03102', 1, 0],
  ])('maps %s to the right power key and values', (generation, key, on, off) => {
    expect(powerValues(generation)).toEqual({ key, on, off })
  })
})

describe('resolveModel', () => {
  it('resolves AC4220/12 via the AC4220 family prefix', () => {
    const config = resolveModel('AC4220/12')
    expect(config.apiGeneration).toBe(ApiGeneration.Gen3)
    expect(Object.keys(config.speeds)).toHaveLength(5)
    expect(config.presetModes.auto).toEqual({ D03102: 1, D0310C: 0 })
    expect(config.presetModes.sleep).toEqual({ D03102: 1, D0310C: 17 })
  })

  it('keeps AC4220 selects matching upstream minus the hardware-promoted lamp mode', () => {
    // Upstream: [NEW2_TIMER2, NEW2_LAMP_MODE, NEW2_PREFERRED_INDEX]. LAMP_MODE
    // moved to `lights` per hardware fact 1 (D03135 is the real light control),
    // but TIMER2 and PREFERRED_INDEX must still be present, in upstream order.
    const config = resolveModel('AC4220/12')
    expect(config.selects).toEqual(['D03110#2', 'D0312A#1'])
    expect(config.lights).toEqual(['D03135'])
  })

  it('prefers an exact match over the family prefix', () => {
    // 'AC0850/81' is an exact registry key, while its 6-char prefix 'AC0850' is
    // not — so this asserts the exact branch is taken, by identity.
    expect(DEVICE_MODELS['AC0850/81']).toBeDefined()
    expect(resolveModel('AC0850/81')).toBe(DEVICE_MODELS['AC0850/81'])
  })

  it('scopes CX3550 transport and preset quirks to that model', () => {
    const cx3550 = resolveModel('CX3550/01')
    expect(cx3550).toMatchObject({
      serviceType: 'fan',
      quietObserve: true,
      ignoreMalformedObservePushes: true,
      restoreManualAfterPreset: true,
      naturalSwitch: true,
      initialStatusNudge: { D0310A: 1 },
      oscillation: { key: 'D0320F', on: 17242, off: 0 },
    })

    const purifier = resolveModel('AC4220/12')
    expect(purifier).toMatchObject({
      serviceType: 'purifier',
      quietObserve: false,
      ignoreMalformedObservePushes: false,
      restoreManualAfterPreset: false,
      naturalSwitch: false,
    })
    expect(purifier.initialStatusNudge).toBeUndefined()
  })

  it('keeps all non-CX3550 registry models on the existing default behavior', () => {
    for (const [name, model] of Object.entries(DEVICE_MODELS)) {
      if (name === 'CX3550') continue

      expect(model.serviceType).toBe('purifier')
      expect(model.quietObserve).toBe(false)
      expect(model.ignoreMalformedObservePushes).toBe(false)
      expect(model.restoreManualAfterPreset).toBe(false)
      expect(model.naturalSwitch).toBe(false)
      expect(model.initialStatusNudge).toBeUndefined()
      expect(model.oscillation).toBeUndefined()
    }
  })

  it('falls back to a generic config for an unknown model', () => {
    const config = resolveModel('XX9999/99', ApiGeneration.Gen3)
    expect(config.apiGeneration).toBe(ApiGeneration.Gen3)
    expect(config.speeds).toEqual({})
  })

  it.each([
    [ApiGeneration.Gen3, { D03102: 0 }, { key: 'D03102', on: 1, off: 0 }],
    [ApiGeneration.Gen2, { 'D03-02': 'OFF' }, { key: 'D03-02', on: 'ON', off: 'OFF' }],
    [ApiGeneration.Gen1, { pwr: '0' }, { key: 'pwr', on: '1', off: '0' }],
  ])('detects %s for an unknown model and uses its power values', (expectedGeneration, status, expectedPower) => {
    const config = resolveModel('XX9999/99', detectGeneration(status))
    expect(config.apiGeneration).toBe(expectedGeneration)
    expect(powerValues(config.apiGeneration)).toEqual(expectedPower)
  })

  it('has all 62 models from the HA registry', () => {
    expect(Object.keys(DEVICE_MODELS).sort()).toEqual([
      'AC0650',
      'AC0850/11 AWS_Philips_AIR',
      'AC0850/11 AWS_Philips_AIR_Combo',
      'AC0850/20 AWS_Philips_AIR',
      'AC0850/20 AWS_Philips_AIR_Combo',
      'AC0850/31 AWS_Philips_AIR',
      'AC0850/31 AWS_Philips_AIR_Combo',
      'AC0850/41 AWS_Philips_AIR',
      'AC0850/41 AWS_Philips_AIR_Combo',
      'AC0850/70 AWS_Philips_AIR',
      'AC0850/70 AWS_Philips_AIR_Combo',
      'AC0850/81',
      'AC0850/85',
      'AC0950',
      'AC0951',
      'AC1214',
      'AC1715',
      'AC2210',
      'AC2221',
      'AC2729',
      'AC2889',
      'AC2936',
      'AC2939',
      'AC2958',
      'AC2959',
      'AC3033',
      'AC3036',
      'AC3039',
      'AC3055',
      'AC3059',
      'AC3210',
      'AC3220',
      'AC3221',
      'AC3259',
      'AC3420',
      'AC3421',
      'AC3737',
      'AC3829',
      'AC3836',
      'AC3854/50',
      'AC3854/51',
      'AC3858/50',
      'AC3858/51',
      'AC3858/83',
      'AC3858/86',
      'AC4220',
      'AC4221',
      'AC4236',
      'AC4550',
      'AC4558',
      'AC5659',
      'AC5660',
      'AMF765',
      'AMF870',
      'CX3120',
      'CX3550',
      'CX5120',
      'CX7550',
      'HU1509',
      'HU1510',
      'HU4209/00',
      'HU5710',
    ])
  })
})
