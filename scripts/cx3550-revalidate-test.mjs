#!/usr/bin/env node

import { PhilipsCoapClient } from '../dist/airctrl/client.js'

const host = process.argv[2]
if (!host) {
  console.error('Usage: node scripts/cx3550-revalidate-test.mjs <fan-ip>')
  process.exit(2)
}

const client = new PhilipsCoapClient(host, 5683, {
  quietObserve: true,
  ignoreMalformedObservePushes: true,
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString()

let stopped = false
const stop = async () => {
  if (stopped) return
  stopped = true
  client.close()
}
process.on('SIGINT', async () => {
  console.log('\nStopping...')
  await stop()
  process.exit(0)
})

try {
  console.log(`[${stamp()}] Connecting to ${host}...`)
  await client.connect()
  console.log(`[${stamp()}] Connected; starting long-lived Observe`)

  const iterator = client.observe()
  let statusCount = 0
  let lastStatusAt = 0

  const reader = (async () => {
    try {
      for await (const status of iterator) {
        statusCount++
        lastStatusAt = Date.now()
        console.log(`[${stamp()}] STATUS #${statusCount}:`, JSON.stringify(status))
      }
    } catch (error) {
      if (!stopped) console.error(`[${stamp()}] Observe failed:`, error)
    }
  })()

  // A quiet Observe does not resolve its initial handshake until the socket's
  // normal ~8s timeout has elapsed. Give it enough time to become a live
  // observation before asking the client to refresh it.
  console.log(`[${stamp()}] Waiting 10s for the Observe registration to settle...`)
  await sleep(10_000)

  console.log(`[${stamp()}] Sending CX3550 bootstrap nudge (D0310A=1)...`)
  const accepted = await client.setControl({ D0310A: 1 }, {
    retries: 0,
    resync: false,
    timeoutMs: 2_000,
    budgetMs: 2_000,
  })
  console.log(`[${stamp()}] Nudge accepted: ${accepted}`)

  const baselineDeadline = Date.now() + 5_000
  while (!lastStatusAt && Date.now() < baselineDeadline) await sleep(100)

  if (!lastStatusAt) {
    console.log(`[${stamp()}] No baseline status arrived after the nudge.`)
    console.log('You can still continue, but the revalidation result will be less conclusive.')
  } else {
    console.log(`[${stamp()}] Baseline status received. Leaving the Observe quiet for 70s...`)
  }

  await sleep(70_000)

  const before = statusCount
  console.log(`[${stamp()}] Revalidating the existing Observe with the SAME token...`)
  const refreshed = client.refreshObservations()
  console.log(`[${stamp()}] Refreshed ${refreshed} live observation(s). Waiting 70s for status...`)

  const refreshDeadline = Date.now() + 70_000
  while (statusCount === before && Date.now() < refreshDeadline) await sleep(100)

  if (statusCount > before) {
    console.log(`[${stamp()}] SUCCESS: revalidation was followed by a status on the existing subscription.`)
  } else {
    console.log(`[${stamp()}] RESULT: no status arrived within 70s of same-token revalidation.`)
  }

  console.log('')
  console.log('The observation is still running. NOW change fan power/speed/oscillation physically or in Air+.')
  console.log('If another STATUS line appears, the original subscription is still live.')
  console.log('Press Ctrl-C when finished.')

  // CoapSocket deliberately unrefs its UDP socket so it cannot keep a Homebridge
  // process alive by itself. This standalone probe needs one referenced handle
  // while we wait for a post-refresh physical/app change.
  process.stdin.resume()
  await reader
} finally {
  await stop()
}
