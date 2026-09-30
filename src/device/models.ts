import { Gen1Key, Gen2Key, Gen3Key } from './keys.js'

export enum ApiGeneration {
  Gen1 = 'gen1',
  Gen2 = 'gen2',
  Gen3 = 'gen3',
}

/** Ordered map from a preset/speed name to the control writes that select it. */
export type ControlWrites = Record<string, string | number>

export interface DeviceModelConfig {
  apiGeneration: ApiGeneration
  /** Named modes not on the speed ladder, e.g. auto, sleep. */
  presetModes: Record<string, ControlWrites>
  /** The speed ladder, in ascending order. Key order defines RotationSpeed steps. */
  speeds: Record<string, ControlWrites>
  switches: string[]
  lights: string[]
  selects: string[]
  numbers: string[]
  unavailableFilters: string[]
  unavailableSensors: string[]
  createFan: boolean
  serviceType: 'purifier' | 'fan'
  oscillation?: { key: string, on: string | number, off: string | number }
}

function config(partial: Partial<DeviceModelConfig> & { apiGeneration: ApiGeneration }): DeviceModelConfig {
  return {
    presetModes: {},
    speeds: {},
    switches: [],
    lights: [],
    selects: [],
    numbers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    createFan: true,
    serviceType: 'purifier',
    ...partial,
  }
}

/**
 * Strip the variant suffix from a registry key.
 *
 * Registry entries like `D03105#1` are not device keys — the `#N` distinguishes
 * variants that share one device key but differ in options. Mirrors the HA
 * integration's `kind.partition("#")[0]`.
 */
export function deviceKey(registryKey: string): string {
  const hash = registryKey.indexOf('#')
  return hash === -1 ? registryKey : registryKey.slice(0, hash)
}

/** The power key and its on/off values differ per API generation. */
export function powerValues(generation: ApiGeneration): { key: string, on: string | number, off: string | number } {
  switch (generation) {
    case ApiGeneration.Gen2: return { key: 'D03-02', on: 'ON', off: 'OFF' }
    case ApiGeneration.Gen3: return { key: 'D03102', on: 1, off: 0 }
    default: return { key: 'pwr', on: '1', off: '0' }
  }
}

// =============================================================================
// Shared preset_modes / speeds configs for model families
// Ported from device_models.py in the HA integration
// (github.com/ruaan-deysel/ha-philips-airpurifier).
// =============================================================================

// --- AC0850 Gen2 (AWS_Philips_AIR) family ---
const AC0850_GEN2_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Auto General' },
  turbo: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Turbo' },
  sleep: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Sleep' },
}
const AC0850_GEN2_SPEEDS: Record<string, ControlWrites> = {
  sleep: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Sleep' },
  turbo: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Turbo' },
}

// --- AC0850 Gen3 (AWS_Philips_AIR_Combo) family ---
const AC0850_GEN3_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 0 },
  turbo: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 18 },
  sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 17 },
}
const AC0850_GEN3_SPEEDS: Record<string, ControlWrites> = {
  sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 17 },
  turbo: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 18 },
}

// --- AC0950 family ---
const AC0950_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 0 },
  turbo: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 18 },
  medium: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 19 },
  sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 17 },
}
const AC0950_SPEEDS: Record<string, ControlWrites> = {
  sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 17 },
  medium: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 19 },
  turbo: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 18 },
}

// --- AC29xx family ---
const AC29XX_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'AG' },
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S' },
  gentle: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'GT' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T' },
}
const AC29XX_SPEEDS: Record<string, ControlWrites> = {
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S' },
  gentle: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'GT' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T' },
}

// --- AC303x family ---
const AC303X_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'AG' },
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
  allergy_sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'AS', [Gen1Key.SPEED]: 'as' },
  speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
  speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
}
const AC303X_SPEEDS: Record<string, ControlWrites> = {
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
  speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
  speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
}

// --- AC305x family ---
const AC305X_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'AG' },
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
  speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
  speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
}
const AC305X_SPEEDS: Record<string, ControlWrites> = {
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
  speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
  speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
}

/**
 * AC32xx / AC4220 / AC4221 modes, hardware-corrected.
 *
 * Verified on hardware: D0310C 1-4 report fan speeds 1-4, and 5 reports 18 —
 * so speed 5 IS turbo. Turbo (18) and medium (19) are therefore NOT listed as
 * presets here: they duplicate speed 5 and speed 3. This correction is applied
 * ONLY to AC4220/AC4221 (the hardware-verified model) — the rest of the AC32xx
 * family below (AC2210/AC2221, AC3210/AC3220/AC3221) is transcribed literally
 * from the (uncorrected) HA registry since those models are not hardware-verified.
 */
const AC32XX_PRESETS_HW: Record<string, ControlWrites> = {
  auto: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 0 },
  sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 17 },
}

/** AC32xx family presets as literally transcribed from the HA registry (includes turbo/medium). */
const AC32XX_PRESETS_FULL: Record<string, ControlWrites> = {
  auto: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 0 },
  medium: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 19 },
  turbo: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 18 },
  sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 17 },
}

const AC32XX_SPEEDS: Record<string, ControlWrites> = {
  speed_1: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 1 },
  speed_2: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 2 },
  speed_3: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 3 },
  speed_4: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 4 },
  speed_5: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 5 },
}

// --- AC385x/50 family ---
const AC385X50_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'AG' },
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
  speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
  speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
}
const AC385X50_SPEEDS: Record<string, ControlWrites> = {
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
  speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
  speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
}

// --- AC385x/51 family ---
const AC385X51_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'AG' },
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
  allergy_sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'AS', [Gen1Key.SPEED]: 'as' },
  speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
  speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
}
const AC385X51_SPEEDS: Record<string, ControlWrites> = {
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
  speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
  speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
}

// --- AC4558 / AC4550 family ---
const AC4558_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'AG', [Gen1Key.SPEED]: 'a' },
  gas: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'F', [Gen1Key.SPEED]: 'a' },
  pollution: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'P', [Gen1Key.SPEED]: 'a' },
  allergen: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'A', [Gen1Key.SPEED]: 'a' },
}
const AC4558_SPEEDS: Record<string, ControlWrites> = {
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.SPEED]: 's' },
  speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.SPEED]: '1' },
  speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.SPEED]: '2' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.SPEED]: 't' },
}

// --- AC5659 / AC5660 family ---
const AC5659_PRESETS: Record<string, ControlWrites> = {
  pollution: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'P' },
  allergen: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'A' },
  bacteria: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'B' },
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 's' },
  speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
  speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
  speed_3: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
}
const AC5659_SPEEDS: Record<string, ControlWrites> = {
  sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 's' },
  speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
  speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
  speed_3: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
  turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
}

// --- AMFxxx family ---
const AMFXXX_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 0 },
  sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 17 },
  turbo: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 18 },
}
const AMFXXX_SPEEDS: Record<string, ControlWrites> = {
  speed_1: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 1 },
  speed_2: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 2 },
  speed_3: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 3 },
  speed_4: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 4 },
  speed_5: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 5 },
  speed_6: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 6 },
  speed_7: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 7 },
  speed_8: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 8 },
  speed_9: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 9 },
  speed_10: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 10 },
}

// --- HU1509/HU1510 & HU5710 family (same preset/speed shape) ---
const HU1509_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 0 },
  sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 17 },
  medium: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 19 },
  high: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 65 },
}
const HU1509_SPEEDS: Record<string, ControlWrites> = {
  sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 17 },
  medium: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 19 },
  high: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 65 },
}

// =============================================================================
// Shared DeviceModelConfig instances for identical models
// =============================================================================

const CONFIG_AC0850_GEN2 = config({
  apiGeneration: ApiGeneration.Gen2,
  presetModes: AC0850_GEN2_PRESETS,
  speeds: AC0850_GEN2_SPEEDS,
  selects: [Gen2Key.PREFERRED_INDEX],
  unavailableFilters: [Gen1Key.FILTER_NANOPROTECT_PREFILTER],
})

const CONFIG_AC0850_GEN3 = config({
  apiGeneration: ApiGeneration.Gen3,
  presetModes: AC0850_GEN3_PRESETS,
  speeds: AC0850_GEN3_SPEEDS,
  unavailableFilters: [Gen1Key.FILTER_NANOPROTECT_PREFILTER],
})

// The upstream registry lists D03105#1 as the light entity, and unlike AC2221 /
// AC3210 / AC3420 / the HUxxxx models, this registry data has no NEW2_LAMP_MODE
// select to promote instead — so there is no documented on-value for this
// model's light control. `lights` is left as-is for provenance, but
// accessory.ts's lightValues() treats any D03105 key as read-only (hardware
// fact 1) and never returns a control for it, so no writable Lightbulb is
// exposed for AC0950 until a real light key is confirmed.
const CONFIG_AC0950 = config({
  apiGeneration: ApiGeneration.Gen3,
  presetModes: AC0950_PRESETS,
  speeds: AC0950_SPEEDS,
  switches: [Gen3Key.CHILD_LOCK, Gen3Key.BEEP],
  lights: [`${Gen3Key.DISPLAY_BACKLIGHT}#1`],
  selects: [`${Gen3Key.PREFERRED_INDEX}#2`, `${Gen3Key.TIMER}#2`],
  unavailableFilters: [Gen1Key.FILTER_NANOPROTECT_PREFILTER],
})

const CONFIG_AC29XX = config({
  apiGeneration: ApiGeneration.Gen1,
  presetModes: AC29XX_PRESETS,
  speeds: AC29XX_SPEEDS,
  switches: [Gen1Key.CHILD_LOCK],
  lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
  selects: [Gen1Key.PREFERRED_INDEX],
})

const CONFIG_AC303X = config({
  apiGeneration: ApiGeneration.Gen1,
  presetModes: AC303X_PRESETS,
  speeds: AC303X_SPEEDS,
  lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
  selects: [Gen1Key.GAS_PREFERRED_INDEX],
})

const CONFIG_AC305X = config({
  apiGeneration: ApiGeneration.Gen1,
  presetModes: AC305X_PRESETS,
  speeds: AC305X_SPEEDS,
  lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
  selects: [Gen1Key.GAS_PREFERRED_INDEX],
})

/**
 * AC32xx / AC4220 / AC4221.
 *
 * Verified on hardware: D0310C 1-4 report fan speeds 1-4, and 5 reports 18 —
 * so speed 5 IS turbo. Turbo (D0310C=18) and medium (19) are therefore NOT
 * listed as presets: they duplicate speed 5 and speed 3 respectively.
 */
const CONFIG_AC4220 = config({
  apiGeneration: ApiGeneration.Gen3,
  presetModes: AC32XX_PRESETS_HW,
  speeds: AC32XX_SPEEDS,
  // LAMP_MODE (D03135) is promoted here per hardware fact 1, not dropped — it
  // is upstream's NEW2_LAMP_MODE, normally a select. Upstream's selects also has
  // NEW2_TIMER2 (D03110#2, confirmed present on the captured device, value 0)
  // ahead of NEW2_PREFERRED_INDEX; keep that ordering.
  lights: [Gen3Key.LAMP_MODE],
  switches: [Gen3Key.CHILD_LOCK, Gen3Key.BEEP, Gen3Key.AUTO_PLUS_AI],
  selects: [`${Gen3Key.TIMER}#2`, `${Gen3Key.PREFERRED_INDEX}#1`],
})

// AC2210/AC2221 (PureProtect Quiet 2200 series). Not hardware-verified: presets
// are transcribed literally from the HA registry (includes turbo/medium).
//
// The upstream registry lists D03105#1 as the light entity, but per hardware fact
// 1 (see keys.ts) D03105 is a read-only status mirror on this API generation.
// This model's registry data already lists NEW2_LAMP_MODE (D03135) as a select —
// promoted here to `lights` instead, the same correction applied to AC4220.
const CONFIG_AC2221 = config({
  apiGeneration: ApiGeneration.Gen3,
  presetModes: AC32XX_PRESETS_FULL,
  speeds: AC32XX_SPEEDS,
  lights: [Gen3Key.LAMP_MODE],
  switches: [Gen3Key.CHILD_LOCK, Gen3Key.BEEP, Gen3Key.AUTO_PLUS_AI],
  selects: [`${Gen3Key.PREFERRED_INDEX}#1`, Gen3Key.AMBIENT_LIGHT_MODE],
})

// AC3210/AC3220/AC3221. Not hardware-verified: presets are transcribed
// literally from the HA registry (includes turbo/medium).
//
// Same D03105/LAMP_MODE correction as CONFIG_AC2221 above — see that comment.
const CONFIG_AC3210 = config({
  apiGeneration: ApiGeneration.Gen3,
  presetModes: AC32XX_PRESETS_FULL,
  speeds: AC32XX_SPEEDS,
  lights: [Gen3Key.LAMP_MODE],
  switches: [Gen3Key.CHILD_LOCK, Gen3Key.BEEP, Gen3Key.AUTO_PLUS_AI],
  // Source literally uses the gen2 preferred-index key here (NEW_PREFERRED_INDEX).
  selects: [Gen2Key.PREFERRED_INDEX, Gen3Key.AMBIENT_LIGHT_MODE],
})

const CONFIG_AC385X50 = config({
  apiGeneration: ApiGeneration.Gen1,
  presetModes: AC385X50_PRESETS,
  speeds: AC385X50_SPEEDS,
  lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
  selects: [Gen1Key.GAS_PREFERRED_INDEX],
})

const CONFIG_AC385X51 = config({
  apiGeneration: ApiGeneration.Gen1,
  presetModes: AC385X51_PRESETS,
  speeds: AC385X51_SPEEDS,
  switches: [Gen1Key.CHILD_LOCK],
  lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
  selects: [Gen1Key.GAS_PREFERRED_INDEX],
})

const CONFIG_AC4558 = config({
  apiGeneration: ApiGeneration.Gen1,
  presetModes: AC4558_PRESETS,
  speeds: AC4558_SPEEDS,
  switches: [Gen1Key.CHILD_LOCK],
  lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
  selects: [Gen1Key.PREFERRED_INDEX],
})

const CONFIG_AC5659 = config({
  apiGeneration: ApiGeneration.Gen1,
  presetModes: AC5659_PRESETS,
  speeds: AC5659_SPEEDS,
  lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
  selects: [Gen1Key.PREFERRED_INDEX],
})

// Same D03105/LAMP_MODE correction as CONFIG_AC2221 above.
const CONFIG_HU1509 = config({
  apiGeneration: ApiGeneration.Gen3,
  presetModes: HU1509_PRESETS,
  speeds: HU1509_SPEEDS,
  createFan: false,
  switches: [Gen3Key.BEEP, Gen3Key.STANDBY_SENSORS],
  lights: [Gen3Key.LAMP_MODE],
  selects: [`${Gen3Key.TIMER}#2`, Gen3Key.AMBIENT_LIGHT_MODE],
})

// Identical to HU1509 but without the ambient-light-mode select.
const CONFIG_HU4209 = config({
  apiGeneration: ApiGeneration.Gen3,
  presetModes: HU1509_PRESETS,
  speeds: HU1509_SPEEDS,
  createFan: false,
  switches: [Gen3Key.BEEP, Gen3Key.STANDBY_SENSORS],
  lights: [Gen3Key.LAMP_MODE],
  selects: [`${Gen3Key.TIMER}#2`],
})

// Same D03105/LAMP_MODE correction as CONFIG_AC2221 above.
const CONFIG_AC3420 = config({
  apiGeneration: ApiGeneration.Gen3,
  presetModes: AC0950_PRESETS,
  speeds: AC0950_SPEEDS,
  switches: [Gen3Key.CHILD_LOCK, Gen3Key.BEEP],
  lights: [Gen3Key.LAMP_MODE],
  selects: [],
  unavailableFilters: [Gen1Key.FILTER_NANOPROTECT_PREFILTER],
})

// =============================================================================
// DEVICE_MODELS: The main mapping.
//
// All 62 entries from DEVICE_MODELS in device_models.py of
// github.com/ruaan-deysel/ha-philips-airpurifier. The brief that authored this
// task stated the registry has 61 entries; a Python AST parse of the cloned
// source shows 62 distinct FanModel keys with no duplicate string values, so
// this file follows the actual source data ("port from data, not memory") —
// see task-5-report.md for details.
//
// status_nudge and requires_mode_cycling are out of scope for v1 and are not
// part of DeviceModelConfig; oscillation/humidifiers/binary_sensors/heaters
// fields present in the Python source are likewise not part of this task's
// DeviceModelConfig shape and are omitted.
// =============================================================================

export const DEVICE_MODELS: Record<string, DeviceModelConfig> = {
  // --- AC0650 ---
  AC0650: CONFIG_AC0850_GEN2,

  // --- AC0850 family ---
  'AC0850/11 AWS_Philips_AIR': CONFIG_AC0850_GEN2,
  'AC0850/11 AWS_Philips_AIR_Combo': CONFIG_AC0850_GEN3,
  'AC0850/20 AWS_Philips_AIR': CONFIG_AC0850_GEN2,
  'AC0850/20 AWS_Philips_AIR_Combo': CONFIG_AC0850_GEN3,
  'AC0850/31 AWS_Philips_AIR': CONFIG_AC0850_GEN2,
  'AC0850/31 AWS_Philips_AIR_Combo': CONFIG_AC0850_GEN3,
  'AC0850/41 AWS_Philips_AIR': CONFIG_AC0850_GEN2,
  'AC0850/41 AWS_Philips_AIR_Combo': CONFIG_AC0850_GEN3,
  'AC0850/70 AWS_Philips_AIR': CONFIG_AC0850_GEN2,
  'AC0850/70 AWS_Philips_AIR_Combo': CONFIG_AC0850_GEN3,
  'AC0850/81': CONFIG_AC0850_GEN3,
  'AC0850/85': CONFIG_AC0850_GEN2,

  // --- AC0950 family ---
  AC0950: CONFIG_AC0950,
  AC0951: CONFIG_AC0950,

  // --- AC1214 ---
  AC1214: config({
    apiGeneration: ApiGeneration.Gen1,
    presetModes: {
      auto: { [Gen1Key.MODE]: 'P' },
      allergen: { [Gen1Key.MODE]: 'A' },
      night: { [Gen1Key.MODE]: 'N' },
      speed_1: { [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      speed_3: { [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
      turbo: { [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
    },
    speeds: {
      night: { [Gen1Key.MODE]: 'N' },
      speed_1: { [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      speed_3: { [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
      turbo: { [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
    },
    switches: [Gen1Key.CHILD_LOCK],
    lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
    selects: [Gen1Key.PREFERRED_INDEX],
    // requires_mode_cycling (AC1214-only) is out of scope for v1, not ported.
  }),

  // --- AC1715 ---
  AC1715: config({
    apiGeneration: ApiGeneration.Gen2,
    presetModes: {
      auto: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Auto General' },
      speed_1: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Gentle/Speed 1' },
      speed_2: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Speed 2' },
      turbo: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Turbo' },
      sleep: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Sleep' },
    },
    speeds: {
      sleep: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Sleep' },
      speed_1: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Gentle/Speed 1' },
      speed_2: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Speed 2' },
      turbo: { [Gen2Key.POWER]: 'ON', [Gen2Key.MODE]: 'Turbo' },
    },
    lights: [Gen2Key.DISPLAY_BACKLIGHT],
    selects: [Gen2Key.PREFERRED_INDEX],
  }),

  // --- AC2210/AC2221 (PureProtect Quiet 2200 series) ---
  AC2210: CONFIG_AC2221,
  AC2221: CONFIG_AC2221,

  // --- AC2729 ---
  AC2729: config({
    apiGeneration: ApiGeneration.Gen1,
    presetModes: {
      auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'P' },
      allergen: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'A' },
      night: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
      speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      speed_3: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
    },
    speeds: {
      night: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
      speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      speed_3: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
    },
    switches: [Gen1Key.CHILD_LOCK, Gen1Key.BEEP],
    lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
    selects: [Gen1Key.PREFERRED_INDEX],
  }),

  // --- AC2889 ---
  AC2889: config({
    apiGeneration: ApiGeneration.Gen1,
    presetModes: {
      auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'P' },
      allergen: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'A' },
      bacteria: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'B' },
      sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 's' },
      speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      speed_3: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
    },
    speeds: {
      sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 's' },
      speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      speed_3: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
    },
    lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
    selects: [Gen1Key.PREFERRED_INDEX],
  }),

  // --- AC29xx family ---
  AC2936: CONFIG_AC29XX,
  AC2939: CONFIG_AC29XX,
  AC2958: CONFIG_AC29XX,
  AC2959: CONFIG_AC29XX,

  // --- AC303x family ---
  AC3033: CONFIG_AC303X,
  AC3036: CONFIG_AC303X,
  AC3039: CONFIG_AC303X,

  // --- AC305x family ---
  AC3055: CONFIG_AC305X,
  AC3059: CONFIG_AC305X,

  // --- AC32xx family ---
  AC3210: CONFIG_AC3210,
  AC3220: CONFIG_AC3210,
  AC3221: CONFIG_AC3210,

  // --- AC3259 ---
  AC3259: config({
    apiGeneration: ApiGeneration.Gen1,
    presetModes: {
      auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'P' },
      allergen: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'A' },
      bacteria: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'B' },
      sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 's' },
      speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      speed_3: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
    },
    speeds: {
      sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 's' },
      speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      speed_3: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
    },
    lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
    selects: [Gen1Key.GAS_PREFERRED_INDEX],
  }),

  // --- AC3420 / AC3421 ---
  AC3420: CONFIG_AC3420,
  AC3421: CONFIG_AC3420,

  // --- AC3737 ---
  // `lights` is upstream registry data kept for provenance only: D03105 is a read-only
  // status mirror, so lightValues() returns no control and no Lightbulb is exposed.
  AC3737: config({
    apiGeneration: ApiGeneration.Gen3,
    presetModes: {
      auto: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 2, [Gen3Key.MODE_B]: 0 },
      sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 2, [Gen3Key.MODE_B]: 17 },
      turbo: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 18 },
    },
    speeds: {
      sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 2, [Gen3Key.MODE_B]: 17 },
      speed_1: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 2, [Gen3Key.MODE_B]: 1 },
      speed_2: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 2, [Gen3Key.MODE_B]: 2 },
      turbo: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 18 },
    },
    lights: [Gen3Key.DISPLAY_BACKLIGHT],
    switches: [Gen3Key.CHILD_LOCK],
    unavailableSensors: [Gen3Key.FAN_SPEED],
  }),

  // --- AC3829 ---
  AC3829: config({
    apiGeneration: ApiGeneration.Gen1,
    presetModes: {
      auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'P' },
      allergen: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'A' },
      sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
      speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      speed_3: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
    },
    speeds: {
      sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
      speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      speed_3: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '3' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: 't' },
    },
    switches: [Gen1Key.CHILD_LOCK],
    lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
    selects: [Gen1Key.GAS_PREFERRED_INDEX],
  }),

  // --- AC3836 ---
  AC3836: config({
    apiGeneration: ApiGeneration.Gen1,
    presetModes: {
      auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'AG', [Gen1Key.SPEED]: '1' },
      sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
    },
    speeds: {
      sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
    },
    lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
    selects: [Gen1Key.GAS_PREFERRED_INDEX],
  }),

  // --- AC385x/50 family ---
  'AC3854/50': CONFIG_AC385X50,
  'AC3858/50': CONFIG_AC385X50,

  // --- AC385x/51 family ---
  'AC3854/51': CONFIG_AC385X51,
  'AC3858/51': CONFIG_AC385X51,
  'AC3858/83': CONFIG_AC385X51,
  'AC3858/86': CONFIG_AC385X51,

  // --- AC4220 / AC4221 ---
  AC4220: CONFIG_AC4220,
  AC4221: CONFIG_AC4220,

  // --- AC4236 ---
  AC4236: config({
    apiGeneration: ApiGeneration.Gen1,
    presetModes: {
      auto: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'AG' },
      sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
      allergy_sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'AS', [Gen1Key.SPEED]: 'as' },
      speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
    },
    speeds: {
      sleep: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'S', [Gen1Key.SPEED]: 's' },
      speed_1: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '1' },
      speed_2: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'M', [Gen1Key.SPEED]: '2' },
      turbo: { [Gen1Key.POWER]: '1', [Gen1Key.MODE]: 'T', [Gen1Key.SPEED]: 't' },
    },
    switches: [Gen1Key.CHILD_LOCK],
    lights: [Gen1Key.DISPLAY_BACKLIGHT, Gen1Key.LIGHT_BRIGHTNESS],
    selects: [Gen1Key.PREFERRED_INDEX],
  }),

  // --- AC4550 / AC4558 ---
  AC4550: CONFIG_AC4558,
  AC4558: CONFIG_AC4558,

  // --- AC5659 / AC5660 ---
  AC5659: CONFIG_AC5659,
  AC5660: CONFIG_AC5659,

  // --- AMF765 ---
  AMF765: config({
    apiGeneration: ApiGeneration.Gen3,
    presetModes: AMFXXX_PRESETS,
    speeds: AMFXXX_SPEEDS,
    lights: [Gen3Key.DISPLAY_BACKLIGHT_PRIMARY],
    switches: [Gen3Key.CHILD_LOCK, Gen3Key.BEEP, Gen3Key.STANDBY_SENSORS, Gen3Key.AUTO_PLUS_AI],
    selects: [`${Gen3Key.MODE_A}#1`],
    numbers: [Gen3Key.OSCILLATION],
    unavailableSensors: [Gen3Key.GAS],
  }),

  // --- AMF870 ---
  AMF870: config({
    apiGeneration: ApiGeneration.Gen3,
    presetModes: AMFXXX_PRESETS,
    speeds: AMFXXX_SPEEDS,
    lights: [Gen3Key.DISPLAY_BACKLIGHT_PRIMARY],
    switches: [Gen3Key.CHILD_LOCK, Gen3Key.BEEP, Gen3Key.STANDBY_SENSORS, Gen3Key.AUTO_PLUS_AI],
    selects: [`${Gen3Key.PREFERRED_INDEX}#2`, `${Gen3Key.MODE_A}#2`],
    numbers: [Gen3Key.TARGET_TEMP],
  }),

  // --- CX3120 ---
  CX3120: config({
    apiGeneration: ApiGeneration.Gen3,
    presetModes: {
      auto_plus: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 0 },
      ventilation: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: -127 },
      low: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 66 },
      medium: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 67 },
      high: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 65 },
    },
    speeds: {
      low: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 66 },
      medium: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 67 },
      high: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 65 },
    },
    unavailableSensors: [Gen3Key.FAN_SPEED, Gen3Key.GAS],
    selects: [`${Gen3Key.TIMER}#2`],
    numbers: [Gen3Key.TARGET_TEMP],
    switches: [Gen3Key.CHILD_LOCK],
  }),

  // --- CX5120 ---
  // `lights` is upstream registry data kept for provenance only: D03105 is a read-only
  // status mirror, so lightValues() returns no control and no Lightbulb is exposed.
  CX5120: config({
    apiGeneration: ApiGeneration.Gen3,
    presetModes: {
      auto: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 0 },
      ventilation: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: -127 },
      low: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 66 },
      high: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 65 },
    },
    speeds: {
      low: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 66 },
      high: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 3, [Gen3Key.MODE_B]: 65 },
    },
    lights: [Gen3Key.DISPLAY_BACKLIGHT],
    switches: [Gen3Key.BEEP],
    unavailableSensors: [Gen3Key.FAN_SPEED, Gen3Key.GAS],
    selects: [`${Gen3Key.TIMER}#2`],
    numbers: [Gen3Key.TARGET_TEMP],
  }),

  // --- CX3550 ---
  CX3550: config({
    apiGeneration: ApiGeneration.Gen3,
    serviceType: 'fan',
    oscillation: { key: Gen3Key.OSCILLATION, on: 23040, off: 0 },
    presetModes: {
      speed_1: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 1 },
      speed_2: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 2 },
      speed_3: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 3 },
      natural: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: -126 },
      sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 17 },
    },
    speeds: {
      speed_1: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 1 },
      speed_2: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 2 },
      speed_3: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 3 },
    },
    switches: [Gen3Key.BEEP],
    selects: [`${Gen3Key.TIMER}#2`],
  }),

  // --- CX7550 ---
  // Fan-only Gen3 device (oscillating tower fan). MODE_A (D0310A) is always 1;
  // everything is driven through MODE_B (D0310C). The top manual speed (12)
  // reports the special code 82, not 12 — there is no separate turbo preset.
  // `lights` is upstream registry data kept for provenance only: D03105 is a read-only
  // status mirror, so lightValues() returns no control and no Lightbulb is exposed.
  CX7550: config({
    apiGeneration: ApiGeneration.Gen3,
    presetModes: {
      auto: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 0 },
      sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 17 },
      natural: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: -126 },
    },
    speeds: {
      speed_1: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 1 },
      speed_2: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 2 },
      speed_3: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 3 },
      speed_4: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 4 },
      speed_5: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 5 },
      speed_6: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 6 },
      speed_7: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 7 },
      speed_8: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 8 },
      speed_9: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 9 },
      speed_10: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 10 },
      speed_11: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 11 },
      // Top speed reports the special max code 82, not 12.
      speed_12: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_A]: 1, [Gen3Key.MODE_B]: 82 },
    },
    lights: [`${Gen3Key.DISPLAY_BACKLIGHT}#2`],
    switches: [Gen3Key.BEEP, Gen3Key.STANDBY_TEMP_DISPLAY],
    selects: [`${Gen3Key.TIMER}#2`],
    unavailableSensors: [Gen3Key.FAN_SPEED, Gen3Key.GAS],
    // status_nudge is out of scope for v1 and not ported.
  }),

  // --- HU1509 / HU1510 (both map to the same HA class) ---
  HU1509: CONFIG_HU1509,
  HU1510: CONFIG_HU1509,

  // --- HU4209 ---
  'HU4209/00': CONFIG_HU4209,

  // --- HU5710 ---
  // Same D03105/LAMP_MODE correction as CONFIG_AC2221 above.
  HU5710: config({
    apiGeneration: ApiGeneration.Gen3,
    presetModes: HU1509_PRESETS,
    speeds: HU1509_SPEEDS,
    createFan: false,
    switches: [
      Gen3Key.CHILD_LOCK,
      Gen3Key.BEEP,
      Gen3Key.QUICKDRY_MODE,
      Gen3Key.AUTO_QUICKDRY_MODE,
      Gen3Key.STANDBY_SENSORS,
    ],
    lights: [Gen3Key.LAMP_MODE],
    selects: [`${Gen3Key.TIMER}#2`, Gen3Key.AMBIENT_LIGHT_MODE],
  }),
}

/**
 * Resolve a reported model string to its capability config.
 *
 * Mirrors the HA integration: exact match, then 6-character family prefix, then
 * a bare generic config. The tested device exercises the middle path —
 * 'AC4220/12' is not a registry key but 'AC4220' is.
 */
export function resolveModel(
  model: string,
  fallbackGeneration: ApiGeneration = ApiGeneration.Gen1,
): DeviceModelConfig {
  return findModel(model) ?? config({ apiGeneration: fallbackGeneration })
}

/**
 * Registry lookup for a reported model string, or undefined when unknown.
 *
 * `modelid` comes off the wire, so a plain `DEVICE_MODELS[model]` would resolve
 * inherited members ('constructor', 'toString', '__proto__') to something truthy
 * and defeat the caller's fallback. Own keys only.
 */
export function findModel(model: string): DeviceModelConfig | undefined {
  return own(model) ?? own(model.slice(0, 6))
}

function own(key: string): DeviceModelConfig | undefined {
  return Object.hasOwn(DEVICE_MODELS, key) ? DEVICE_MODELS[key] : undefined
}

/**
 * Guess the API generation from the keys a device actually reports. Used when the
 * model is unknown, so a new device still gets basic control.
 */
export function detectGeneration(status: Record<string, unknown>): ApiGeneration {
  if ('D03102' in status) return ApiGeneration.Gen3
  if ('D03-02' in status) return ApiGeneration.Gen2
  return ApiGeneration.Gen1
}
