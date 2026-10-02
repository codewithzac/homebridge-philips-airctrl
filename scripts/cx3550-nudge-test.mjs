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

function showStatus(message, label) {
  try {
    const status = client.parseStatus(message)
    console.log(label)
    console.dir(status, { depth: null })
  } catch (error) {
    console.log(`${label} (packet arrived but status parsing failed)`)
    console.log(error)
  }
}

let observation

try {
  console.log(`Connecting to ${host}:${port}...`)
  await client.connect()
  console.log('Connected.')

  console.log('Registering ONE Confirmable (CON) Observe...')
  let resolvePush
  const pushPromise = new Promise(resolve => {
    resolvePush = resolve
  })

  observation = await client.socket.observe({
    path: '/sys/dev/status',
    allowQuiet: true,
    timeoutMs: 1500,
    confirmable: true,
    onNotify: message => resolvePush(message),
  })

  if (observation.first) {
    showStatus(observation.first, 'Confirmable Observe immediately returned a status:')
  } else {
    console.log('Confirmable Observe started quietly. Waiting 5 s for a notification...')
    const result = await withTimeout(pushPromise, 5000)

    if (result?.timeout) {
      console.log('No status arrived within 5 s of the Confirmable Observe.')
      process.exitCode = 1
    } else {
      showStatus(result, 'Status arrived after Confirmable Observe:')
    }
  }
} catch (error) {
  console.error('Test failed:', error)
  process.exitCode = 1
} finally {
  try {
    observation?.cancel()
  } catch {
    // Ignore cleanup errors.
  }
  client.close()
}
