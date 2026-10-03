#!/usr/bin/env node

import { PhilipsCoapClient } from '../dist/airctrl/client.js'

const host = process.argv[2]
const xMinutes = Number(process.argv[3] ?? 5)
const yMinutes = Number(process.argv[4] ?? 5)

if (!host || !Number.isFinite(xMinutes) || !Number.isFinite(yMinutes) || xMinutes < 0 || yMinutes < 0) {
  console.error('Usage: node scripts/cx3550-liveness-test.mjs <fan-ip> [x-minutes=5] [y-minutes=5]')
  process.exit(2)
}

const client = new PhilipsCoapClient(host, 5683, {
  quietObserve: true,
  ignoreMalformedObservePushes: true,
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString()

let stopped = false
let originalPower
let statusCount = 0
let lastStatus
let resolveNextStatus

const waitForNextStatus = timeoutMs => new Promise(resolve => {
  const timer = setTimeout(() => {
    if (resolveNextStatus === finish) resolveNextStatus = undefined
    resolve(undefined)
  }, timeoutMs)
  const finish = status => {
    clearTimeout(timer)
    if (resolveNextStatus === finish) resolveNextStatus = undefined
    resolve(status)
  }
  resolveNextStatus = finish
})

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
  const reader = (async () => {
    try {
      for await (const status of iterator) {
        statusCount++
        lastStatus = status
        if (originalPower === undefined && typeof status.D03102 === 'number') originalPower = status.D03102
        console.log(`[${stamp()}] STATUS #${statusCount}:`, JSON.stringify(status))
        resolveNextStatus?.(status)
      }
    } catch (error) {
      if (!stopped) console.error(`[${stamp()}] Observe failed:`, error)
    }
  })()

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

  const baseline = await waitForNextStatus(5_000)
  if (!baseline) {
    console.log(`[${stamp()}] No baseline status arrived within 5s; stopping because initial power state is unknown.`)
    process.exitCode = 1
  } else {
    console.log(`[${stamp()}] Baseline received; original power state is D03102=${originalPower}.`)
    console.log(`[${stamp()}] Leaving the connection idle for ${xMinutes} minute(s)...`)
    await sleep(xMinutes * 60_000)

    console.log(`[${stamp()}] Refreshing the existing Observe with the SAME token...`)
    const refreshed = client.refreshObservations()
    console.log(`[${stamp()}] Refreshed ${refreshed} live observation(s).`)

    console.log(`[${stamp()}] Probing /sys/dev/info...`)
    const infoStart = Date.now()
    try {
      const info = await client.getInfo()
      console.log(`[${stamp()}] INFO probe succeeded in ${Date.now() - infoStart}ms: ${JSON.stringify(info)}`)
    } catch (error) {
      console.error(`[${stamp()}] INFO probe FAILED after ${Date.now() - infoStart}ms: ${String(error)}`)
    }

    console.log(`[${stamp()}] Waiting another ${yMinutes} minute(s) with no interaction...`)
    await sleep(yMinutes * 60_000)

    const beforeControl = statusCount
    console.log(`[${stamp()}] Sending power OFF (D03102=0)...`)
    const controlStart = Date.now()
    let powerOffAccepted = false
    try {
      powerOffAccepted = await client.setControl({ D03102: 0 }, {
        retries: 0,
        resync: false,
        timeoutMs: 2_000,
        budgetMs: 2_000,
      })
      console.log(`[${stamp()}] Power-off accepted=${powerOffAccepted} in ${Date.now() - controlStart}ms.`)
    } catch (error) {
      console.error(`[${stamp()}] Power-off FAILED after ${Date.now() - controlStart}ms: ${String(error)}`)
    }

    console.log(`[${stamp()}] Waiting up to 10s for the EXISTING Observe to report the resulting state...`)
    let observedOff
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const status = await waitForNextStatus(Math.min(remaining, 1_000))
      if (status?.D03102 === 0) {
        observedOff = status
        break
      }
    }

    if (observedOff) {
      console.log(`[${stamp()}] SUCCESS: power-off was reported by the existing Observe subscription.`)
    } else if (statusCount > beforeControl) {
      console.log(`[${stamp()}] PARTIAL: Observe produced status after power-off, but D03102=0 was not seen within 10s.`)
    } else {
      console.log(`[${stamp()}] RESULT: no Observe status arrived within 10s of power-off.`)
    }

    if (originalPower === 1) {
      console.log(`[${stamp()}] Restoring original ON state...`)
      try {
        const restored = await client.setControl({ D03102: 1 }, {
          retries: 0,
          resync: false,
          timeoutMs: 2_000,
          budgetMs: 2_000,
        })
        console.log(`[${stamp()}] Restore accepted: ${restored}`)
      } catch (error) {
        console.error(`[${stamp()}] Restore FAILED: ${String(error)}`)
      }
    } else {
      console.log(`[${stamp()}] Original state was OFF; leaving fan off.`)
    }

    console.log('')
    console.log('Summary:')
    console.log(`  Observe refreshes requested: ${refreshed}`)
    console.log(`  Power-off control accepted: ${powerOffAccepted}`)
    console.log(`  Existing Observe reported OFF: ${Boolean(observedOff)}`)
    console.log(`  Total statuses seen: ${statusCount}`)
    console.log('')
    console.log('Probe complete. Press Ctrl-C if the process remains open.')
  }

  process.stdin.resume()
  await reader
} finally {
  await stop()
}
