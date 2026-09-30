import { z } from 'zod'

/**
 * Device status is a flat bag of opaque keys whose meaning depends on the model.
 * Validating individual keys here would reject every device whose key set differs
 * from the one we tested, so this only asserts the envelope shape. Interpreting
 * keys is device/keys.ts and device/models.ts's job.
 */
export const StatusPayloadSchema = z.object({
  state: z.object({
    reported: z.record(z.string(), z.unknown()),
  }),
})

export type DeviceStatus = Record<string, unknown>

/** Parse a decrypted status payload and return the reported state. */
export function parseStatusPayload(json: string): DeviceStatus {
  const parsed = StatusPayloadSchema.safeParse(JSON.parse(json))
  if (!parsed.success) {
    throw new Error(`unexpected status payload shape (no state.reported): ${parsed.error.message}`)
  }
  return parsed.data.state.reported
}

/** The plaintext /sys/dev/info response. Only modelid is load-bearing. */
export const DeviceInfoSchema = z.looseObject({
  modelid: z.string().optional(),
  name: z.string().optional(),
  device_id: z.string().optional(),
  product_id: z.string().optional(),
  swversion: z.string().optional(),
  type: z.string().optional(),
})

export type DeviceInfo = z.infer<typeof DeviceInfoSchema>

export const DeviceConfigSchema = z.object({
  host: z.string().min(1, 'host is required'),
  /** Optional display-name override; otherwise the device's own name is used. */
  name: z.string().optional(),
  /**
   * Model recorded by the setup UI, for display only. Declared so zod's default
   * key-stripping does not silently drop what the UI wrote.
   */
  model: z.string().optional(),
  port: z.number().int().positive().default(5683),
  /** Sleep is a distinct device mode, so it is offered separately from the speed slider. */
  exposeSleepSwitch: z.boolean().default(false),
  /** Natural Breeze is a distinct fan mode, exposed separately from the speed slider. */
  exposeNaturalSwitch: z.boolean().default(false),
  /** Auto+ AI (D03180). */
  exposeAutoPlusSwitch: z.boolean().default(false),
  /** Beep (D03130). On writes 100, not 1 — see device/keys.ts. */
  exposeBeepSwitch: z.boolean().default(false),
  /** Lamp mode (D03135) as a Lightbulb. */
  exposeLight: z.boolean().default(true),
})

export type DeviceConfig = z.infer<typeof DeviceConfigSchema>

export const PluginConfigSchema = z.looseObject({
  platform: z.string(),
  name: z.string().optional(),
  devices: z.array(DeviceConfigSchema).default([]),
})

export type PluginConfig = z.infer<typeof PluginConfigSchema>
