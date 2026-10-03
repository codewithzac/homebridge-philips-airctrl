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

function printStatus(label, status) {
  console.log(label)
  console.dir(status, { depth: null })
}

try {
  console.log(`Connecting to ${host}:${port}...`)
  await client.connect()
  console.log('Connected.')

  console.log('Starting quiet Observe subscription...')
  let pendingStatus = iterator.next()
  const spontaneous = await withTimeout(pendingStatus, 1500)

  if (!spontaneous?.timeout) {
    if (spontaneous.done) {
      console.log('Observe ended before the test could run.')
      process.exitCode = 1
    } else {
      printStatus('A status arrived without a nudge:', spontaneous.value)
      pendingStatus = iterator.next()
    }
  } else {
    console.log('No status arrived within 1.5 s. Sending ONE control write: D0310A = 1...')
    const started = Date.now()

    const accepted = await client.setControl({ D0310A: 1 }, {
      retries: 0,
      resync: false,
      timeoutMs: 2000,
      budgetMs: 2000,
    })

    console.log(`Control response: ${accepted ? 'success' : 'failed/rejected'}`)

    const result = await withTimeout(pendingStatus, 10000)
    if (result?.timeout) {
      console.log('No Observe status arrived within 10 s of D0310A = 1.')
      process.exitCode = 1
    } else if (result.done) {
      console.log('Observe ended without yielding a status.')
      process.exitCode = 1
    } else {
      console.log(`Observe status arrived after ${Date.now() - started} ms:`)
      console.dir(result.value, { depth: null })
      pendingStatus = iterator.next()
    }
  }

  if (process.exitCode !== 1) {
    console.log('')
    console.log('Monitoring subsequent Observe pushes for 90 s.')
    console.log('Change something in Air+ now; every status notification will be printed.')
    console.log('Press Ctrl+C to stop early.')
    console.log('')

    const deadline = Date.now() + 90000
    let count = 0

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const result = await withTimeout(pendingStatus, remaining)

      if (result?.timeout) break
      if (result.done) {
        console.log('Observe ended while monitoring.')
        process.exitCode = 1
        break
      }

      count++
      printStatus(`Observe push #${count}:`, result.value)
      pendingStatus = iterator.next()
    }

    console.log(`Monitoring complete. Subsequent Observe pushes seen: ${count}`)
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
