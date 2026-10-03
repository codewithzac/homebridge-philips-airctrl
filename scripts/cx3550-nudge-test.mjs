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

async function sendNudge(label) {
  const started = Date.now()
  console.log(`${label}: sending D0310A = 1...`)
  const accepted = await client.setControl({ D0310A: 1 }, {
    retries: 0,
    resync: false,
    timeoutMs: 2000,
    budgetMs: 2000,
  })
  console.log(`${label}: control response: ${accepted ? 'success' : 'failed/rejected'}`)
  return started
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
    const started = await sendNudge('Initial nudge')
    const result = await withTimeout(pendingStatus, 10000)

    if (result?.timeout) {
      console.log('No Observe status arrived within 10 s of the initial D0310A = 1.')
      process.exitCode = 1
    } else if (result.done) {
      console.log('Observe ended without yielding a status.')
      process.exitCode = 1
    } else {
      console.log(`Initial nudge Observe status arrived after ${Date.now() - started} ms:`)
      console.dir(result.value, { depth: null })
      pendingStatus = iterator.next()
    }
  }

  if (process.exitCode !== 1) {
    console.log('')
    console.log('Now trigger a StatusType: status push (Air+ or a physical control change).')
    console.log('After one is seen, the script will keep consuming/printing Observe packets for 10 s,')
    console.log('then send D0310A = 1 again and wait up to 10 s for a genuinely later push.')
    console.log('Press Ctrl+C to stop early.')
    console.log('')

    const deadline = Date.now() + 120000
    let count = 0
    let sawStatusTypeStatus = false

    while (Date.now() < deadline && !sawStatusTypeStatus) {
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

      if (result.value?.StatusType === 'status') {
        sawStatusTypeStatus = true
        console.log('')
        console.log('Saw StatusType: status. Draining/printing any further Observe traffic for 10 s...')

        const drainDeadline = Date.now() + 10000
        while (Date.now() < drainDeadline) {
          const remainingDrain = drainDeadline - Date.now()
          const drainResult = await withTimeout(pendingStatus, remainingDrain)

          if (drainResult?.timeout) break
          if (drainResult.done) {
            console.log('Observe ended during the 10 s drain window.')
            process.exitCode = 1
            break
          }

          count++
          printStatus(`Observe push #${count} (during 10 s drain):`, drainResult.value)
          pendingStatus = iterator.next()
        }

        if (process.exitCode !== 1) {
          console.log('Drain window complete. Sending the second nudge now...')
          const started = await sendNudge('Second nudge')
          const nudgeResult = await withTimeout(pendingStatus, 10000)

          if (nudgeResult?.timeout) {
            console.log('No Observe status arrived within 10 s of the second D0310A = 1.')
            process.exitCode = 1
          } else if (nudgeResult.done) {
            console.log('Observe ended without yielding a status after the second nudge.')
            process.exitCode = 1
          } else {
            console.log(`Second nudge Observe status arrived after ${Date.now() - started} ms:`)
            console.dir(nudgeResult.value, { depth: null })
          }
        }
      }
    }

    if (!sawStatusTypeStatus && process.exitCode !== 1) {
      console.log('No StatusType: status push was seen within 120 s.')
      process.exitCode = 1
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
