// Pure config-manipulation logic for the custom UI, kept free of DOM/homebridge
// globals so it can be unit-tested directly (see test/ui.test.ts).

export function ensureConfig(blocks) {
  if (blocks.length === 0) blocks.push({ platform: 'PhilipsAirPurifier', name: 'Philips Air Purifier', devices: [] })
  if (!Array.isArray(blocks[0].devices)) blocks[0].devices = []
  return blocks
}

export function deviceTitle(device) {
  return device.name || device.model || device.host
}

// Returns true if the device was added, false if its host was already configured.
export function addDeviceToConfig(blocks, device) {
  if (blocks[0].devices.some(existing => existing.host === device.host)) return false
  blocks[0].devices.push({
    host: device.host,
    name: device.name || device.model,
    model: device.model,
    exposeLight: true,
    exposeSleepSwitch: false,
    exposeNaturalSwitch: false,
    exposeAutoPlusSwitch: false,
    exposeBeepSwitch: false,
  })
  return true
}

// Returns true if a device with the given host was removed.
export function removeDeviceFromConfig(blocks, host) {
  const index = blocks[0].devices.findIndex(candidate => candidate.host === host)
  if (index === -1) return false
  blocks[0].devices.splice(index, 1)
  return true
}

// Sets a per-device toggle. Throws if the host is no longer configured.
export function setDeviceToggle(blocks, host, key, value) {
  const device = blocks[0].devices.find(candidate => candidate.host === host)
  if (!device) throw new Error(`${host} is no longer configured.`)
  device[key] = value
}

// Serializes concurrent config read-mutate-save cycles so overlapping calls
// (e.g. two toggles flipped in quick succession) apply in order instead of
// racing on a stale read. `load`/`save` are injected so this stays pure.
export function createConfigMutator(load, save) {
  let chain = Promise.resolve()

  return function mutateConfig(mutator) {
    const operation = chain.then(async () => {
      const blocks = ensureConfig(await load())
      if (mutator(blocks) === false) return false
      await save(blocks)
      return true
    })
    chain = operation.catch(() => {})
    return operation
  }
}
