#!/usr/bin/env node

import dgram from 'node:dgram'
import { randomBytes, randomInt } from 'node:crypto'
import {
  CoapCode,
  CoapOption,
  CoapType,
  decode,
  encode,
  uintToBuffer,
  uriPathOptions,
} from '../dist/airctrl/coap/message.js'
import { decrypt, encrypt, nextKey } from '../dist/airctrl/crypto.js'
import { parseStatusPayload } from '../dist/airctrl/schema.js'

const host = process.argv[2]
const port = 5683

if (!host) {
  console.error('Usage: node scripts/cx3550-observe-repair-test.mjs <fan-ip>')
  process.exit(2)
}

const STATUS_PATH = '/sys/dev/status'
const CONTROL_PATH = '/sys/dev/control'
const SYNC_PATH = '/sys/dev/sync'
const REQUEST_TIMEOUT_MS = 2_000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString()
const tokenKey = token => token.toString('hex')

class ProbeSocket {
  constructor(host, port) {
    this.host = host
    this.port = port
    this.socket = dgram.createSocket('udp4')
    this.handlers = new Map()
    this.messageId = randomInt(0, 0x10000)
    this.socket.on('message', buffer => {
      let message
      try {
        message = decode(buffer)
      } catch {
        return
      }
      this.handlers.get(tokenKey(message.token))?.(message)
    })
  }

  nextMessageId() {
    this.messageId = (this.messageId + 1) & 0xffff
    return this.messageId
  }

  send({ method = 'GET', path, token, observeValue, payload }) {
    const options = uriPathOptions(path)
    if (observeValue !== undefined) {
      options.push({ number: CoapOption.Observe, value: uintToBuffer(observeValue) })
    }
    this.socket.send(encode({
      type: CoapType.NonConfirmable,
      code: method === 'POST' ? CoapCode.POST : CoapCode.GET,
      messageId: this.nextMessageId(),
      token,
      options,
      payload: payload === undefined
        ? undefined
        : (Buffer.isBuffer(payload) ? payload : Buffer.from(payload)),
    }), this.port, this.host)
  }

  request({ method = 'GET', path, payload, timeoutMs = REQUEST_TIMEOUT_MS }) {
    const token = randomBytes(4)
    const key = tokenKey(token)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(key)
        reject(new Error(`timeout waiting for ${method} ${path}`))
      }, timeoutMs)
      this.handlers.set(key, message => {
        clearTimeout(timer)
        this.handlers.delete(key)
        resolve(message)
      })
      this.send({ method, path, token, payload })
    })
  }

  install(token, handler) {
    this.handlers.set(tokenKey(token), handler)
  }

  remove(token) {
    this.handlers.delete(tokenKey(token))
  }

  close() {
    this.handlers.clear()
    this.socket.close()
  }
}

const socket = new ProbeSocket(host, port)
let clientKey
let originalPower
let currentPower
let statusCount = 0
let lastStatus
let resolveStatus

function waitForStatus(timeoutMs) {
  return new Promise(resolve => {
    let finished = false
    const finish = status => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (resolveStatus === finish) resolveStatus = undefined
      resolve(status)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    resolveStatus = finish
  })
}

function handleObserveMessage(message) {
  try {
    const status = parseStatusPayload(decrypt(message.payload.toString()))
    statusCount++
    lastStatus = status
    if (typeof status.D03102 === 'number') {
      currentPower = status.D03102
      if (originalPower === undefined) originalPower = status.D03102
    }
    console.log(`[${stamp()}] OBSERVE STATUS #${statusCount}:`, JSON.stringify(status))
    resolveStatus?.(status)
  } catch (error) {
    console.log(`[${stamp()}] Observe-token packet ignored: ${String(error)}`)
  }
}

async function sync() {
  const nonce = randomBytes(4).toString('hex').toUpperCase()
  const response = await socket.request({ method: 'POST', path: SYNC_PATH, payload: nonce })
  clientKey = response.payload.toString().trim()
  console.log(`[${stamp()}] Synced; client key established.`)
}

async function setControl(values) {
  clientKey = nextKey(clientKey)
  const payload = JSON.stringify({
    state: {
      desired: {
        CommandType: 'app',
        DeviceId: '',
        EnduserId: '',
        ...values,
      },
    },
  })
  const response = await socket.request({
    method: 'POST',
    path: CONTROL_PATH,
    payload: encrypt(clientKey, payload),
  })
  return JSON.parse(response.payload.toString()).status === 'success'
}

async function main() {
  console.log(`[${stamp()}] Connecting diagnostic probe to ${host}...`)
  await sync()

  const observeToken = randomBytes(4)
  socket.install(observeToken, handleObserveMessage)
  socket.send({ path: STATUS_PATH, token: observeToken, observeValue: 0 })
  console.log(`[${stamp()}] Observe registered with token ${tokenKey(observeToken)}; waiting 10s...`)
  await sleep(10_000)

  console.log(`[${stamp()}] Sending bootstrap nudge D0310A=1...`)
  console.log(`[${stamp()}] Bootstrap accepted: ${await setControl({ D0310A: 1 })}`)
  const baseline = await waitForStatus(5_000)
  if (!baseline || originalPower === undefined) {
    throw new Error('No baseline status/power state received; cannot run reversible test safely.')
  }

  console.log(`[${stamp()}] Baseline power is D03102=${originalPower}.`)
  console.log(`[${stamp()}] Sending Observe=1 with SAME token, but deliberately keeping the local handler installed...`)
  socket.send({ path: STATUS_PATH, token: observeToken, observeValue: 1 })

  // Drain any response directly associated with deregistration before testing
  // whether a later device state change is still pushed to this token.
  await sleep(1_500)
  const beforeDeregisteredChange = statusCount
  const oppositePower = originalPower === 1 ? 0 : 1

  console.log(`[${stamp()}] Changing power to D03102=${oppositePower} while remotely deregistered...`)
  const changed = await setControl({ D03102: oppositePower })
  console.log(`[${stamp()}] Test change accepted: ${changed}; waiting 4s for an Observe notification...`)
  await sleep(4_000)

  if (statusCount > beforeDeregisteredChange) {
    console.log(`[${stamp()}] INCONCLUSIVE: a status arrived after Observe=1, so remote deregistration was not proven.`)
    console.log(`[${stamp()}] Restoring original power state before exiting...`)
    await setControl({ D03102: originalPower })
    return
  }

  console.log(`[${stamp()}] GOOD: no Observe notification followed the state change; server-side deregistration appears effective.`)
  console.log(`[${stamp()}] Re-sending Observe=0 with the SAME token to repair the registration...`)
  socket.send({ path: STATUS_PATH, token: observeToken, observeValue: 0 })

  // A compliant server may answer re-registration immediately. Record it, but
  // the stronger check is whether the subsequent state change is observed.
  await sleep(1_500)
  const beforeRestore = statusCount

  console.log(`[${stamp()}] Restoring original power state D03102=${originalPower}...`)
  const restored = await setControl({ D03102: originalPower })
  console.log(`[${stamp()}] Restore accepted: ${restored}; waiting up to 6s for the repaired Observe...`)

  let repaired = false
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline) {
    if (statusCount > beforeRestore && lastStatus?.D03102 === originalPower) {
      repaired = true
      break
    }
    await sleep(100)
  }

  console.log('')
  if (repaired) {
    console.log('SUCCESS: same-token Observe=0 repaired the deliberately removed server-side subscription.')
  } else {
    console.log('RESULT: no matching status arrived after same-token re-registration and restore.')
  }
  console.log(`Observe token: ${tokenKey(observeToken)}`)
  console.log(`Total Observe statuses seen: ${statusCount}`)
  console.log(`Final observed power: ${lastStatus?.D03102 ?? 'unknown'}`)
  console.log(`Expected restored power: ${originalPower}`)
}

try {
  await main()
} catch (error) {
  console.error(`[${stamp()}] Probe failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  // Best-effort restore if we learned the original state and later changed it.
  if (originalPower !== undefined && currentPower !== originalPower) {
    try {
      console.log(`[${stamp()}] Best-effort restore to D03102=${originalPower}...`)
      await setControl({ D03102: originalPower })
    } catch (restoreError) {
      console.error(`[${stamp()}] Restore failed: ${String(restoreError)}`)
    }
  }
  process.exitCode = 1
} finally {
  socket.close()
}
