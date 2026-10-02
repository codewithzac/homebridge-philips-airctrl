#!/usr/bin/env node

import { PhilipsCoapClient } from '../dist/airctrl/client.js'

const host = process.argv[2]
const portArg = process.argv[3]
const port = portArg ? Number(portArg) : 5683

if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Usage: node scripts/cx3550-nudge-test.mjs <host> [port]')
  process.exit(2)
}

const client = new PhilipsCoapClient(host, port, {
  quietObserve: true,
  ignoreMalformedObservePushes: true,
})

const iterator = client.observe()[Symbol.asyncIterator]()

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise(resolve => {
      timer = setTimeout(() => resolve({ timeout: true }), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

try {
  console.log(`Connecting to ${host}:${port}...`)
  await client.connect()
  console.log('Connected.')

  console.log('Starting quiet Observe subscription...')
  const pendingStatus = iterator.next()
  const spontaneous = await withTimeout(pendingStatus, 1500)

  if (!spontaneous?.timeout) {
    if (spontaneous.done) {
      console.log('Observe ended before the test could run.')
      process.exitCode = 1
    } else {
      console.log('A status arrived without a nudge:')
      console.dir(spontaneous.value, { depth: null })
      console.log('No plain status GET was attempted.')
    }
  } else {
    console.log('No status arrived within 1.5 s. Performing ONE plain GET /sys/dev/status...')
    const started = Date.now()

    // Deliberately use the same CoAP socket/session as the active Observe.
    // This is a temporary diagnostic probe; TypeScript's private field is still
    // a normal property in the emitted JavaScript.
    let getResult
    try {
      getResult = await withTimeout(
        client.socket.request({
          method: 'GET',
          path: '/sys/dev/status',
          timeoutMs: 2000,
        }),
        2500,
      )
    } catch (error) {
      console.log('Plain status GET failed:', error)
    }

    if (getResult?.timeout) {
      console.log('Plain status GET: no direct response within 2.5 s.')
    } else if (getResult) {
      console.log(`Plain status GET direct response: code=${getResult.code}, payload length=${getResult.payload?.length ?? 0}`)
    }

    const result = await withTimeout(pendingStatus, 5000)
    if (result?.timeout) {
      console.log('No Observe status arrived within 5 s of the plain status GET.')
      process.exitCode = 1
    } else if (result.done) {
      console.log('Observe ended without yielding a status.')
      process.exitCode = 1
    } else {
      console.log(`Observe status arrived after ${Date.now() - started} ms:`)
      console.dir(result.value, { depth: null })
    }
  }
} catch (error) {
  console.error('Test failed:', error)
  process.exitCode = 1
} finally {
  try {
    await iterator.return?.()
  } catch {
    // Ignore cleanup errors from an already-ended observation.
  }
  client.close()
}
