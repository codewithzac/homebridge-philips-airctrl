// Ambient types for the plain-JS homebridge-ui/ files. They ship as-is (no
// build step, no allowJs on the shipped tsconfig) — this only types the
// exports the tests actually import.
//
// Two constraints shape this file:
//  - It must stay a global script (no top-level import/export): a top-level
//    import turns it into a module, and `declare module "..."` inside a
//    module is treated as *augmenting* an existing module rather than
//    declaring a new ambient one.
//  - The module names below use a leading `*` wildcard rather than the
//    literal relative path: TS rejects `declare module "../relative/path"`
//    outright (TS2436, "cannot specify relative module name"). A wildcard
//    ambient module is the supported way to type a real, resolvable file by
//    path suffix.

type DiscoveredDevice = import('../src/airctrl/discovery.js').DiscoveredDevice
type DiscoverOptions = import('../src/airctrl/discovery.js').DiscoverOptions

declare module '*/homebridge-ui/server.js' {
  export interface ProbeDependencies {
    probeHost: (host: string, port: number, timeoutMs: number) => Promise<DiscoveredDevice | null>
  }
  export interface ScanDependencies {
    discover: (options: DiscoverOptions) => Promise<DiscoveredDevice[]>
    hostsInSubnet: (cidr: string) => Generator<string>
    localSubnets: () => string[]
  }
  export interface CapabilitiesDependencies {
    findModel: (model: string) => { naturalSwitch?: boolean } | undefined
  }
  export function capabilitiesRequest(
    payload?: { model?: string },
    dependencies?: CapabilitiesDependencies,
  ): Promise<{ naturalSwitch: boolean }>
  export function probeRequest(
    payload?: { host?: string, port?: unknown },
    dependencies?: ProbeDependencies,
  ): Promise<{ device: DiscoveredDevice }>
  export function scanRequest(
    payload?: { subnet?: string },
    dependencies?: ScanDependencies,
  ): Promise<{ subnet: string, scanned: number, devices: DiscoveredDevice[] }>
}

declare module '*/homebridge-ui/public/config-ops.js' {
  export interface DeviceInput {
    host: string
    model?: string
    name?: string
  }

  export interface DeviceConfigBlock extends DeviceInput {
    exposeLight?: boolean
    exposeSleepSwitch?: boolean
    exposeNaturalSwitch?: boolean
    exposeAutoPlusSwitch?: boolean
    exposeBeepSwitch?: boolean
    [key: string]: unknown
  }

  export interface ConfigBlock {
    platform: string
    name?: string
    devices: DeviceConfigBlock[]
    [key: string]: unknown
  }

  export function ensureConfig(blocks: ConfigBlock[]): ConfigBlock[]
  export function deviceTitle(device: DeviceInput): string
  export function addDeviceToConfig(blocks: ConfigBlock[], device: DeviceInput): boolean
  export function removeDeviceFromConfig(blocks: ConfigBlock[], host: string): boolean
  export function setDeviceToggle(blocks: ConfigBlock[], host: string, key: string, value: unknown): void
  export function createConfigMutator(
    load: () => Promise<ConfigBlock[]>,
    save: (blocks: ConfigBlock[]) => Promise<void>,
  ): (mutator: (blocks: ConfigBlock[]) => unknown) => Promise<boolean>
}
