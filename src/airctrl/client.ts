import { randomBytes } from 'node:crypto'
import { decrypt, encrypt, MalformedPayloadError, nextKey } from './crypto.js'
import {
  DeviceInfoSchema,
  parseStatusPayload,
  type DeviceInfo,
  type DeviceStatus,
} from './schema.js'
import { CoapOption, bufferToUint, findOption, type DecodedCoapMessage } from './coap/message.js'
import { CoapSocket, type Observation } from './coap/socket.js'

const STATUS_PATH = '/sys/dev/status'
const CONTROL_PATH = '/sys/dev/control'
const SYNC_PATH = '/sys/dev/sync'
const INFO_PATH = '/sys/dev/info'
const DEFAULT_MAX_AGE = 60

export class NotConnectedError extends Error {
  constructor() {
    super('client key not initialised; call connect() first')
    this.name = 'NotConnectedError'
  }
}

export class NoInitialStatusError extends Error {
  constructor() {
    super('device accepted status observation but sent no initial status')
    this.name = 'NoInitialStatusError'
  }
}

export interface PhilipsCoapClientOptions {
  quietObserve?: boolean
  ignoreMalformedObservePushes?: boolean
}

export interface SetControlOptions {
  retries?: number
  retryDelayMs?: number
  resync?: boolean
  /**
   * Per-request CoAP timeout for the control write and any resync, kept short so
   * a dead device fails fast instead of quietly exhausting HAP-NodeJS's ~10s
   * onSet budget while the caller is still awaiting a response.
   */
  timeoutMs?: number
  /** Hard wall-clock ceiling on the whole retry loop. */
  budgetMs?: number
}

export class PhilipsCoapClient {
  private readonly socket: CoapSocket
  private readonly observations = new Set<Observation>()
  private readonly observationFailures = new Map<Observation, (error: Error) => void>()
  private clientKey?: string
  private closed = false
  /** Serialises {@link setControl}: the rolling key must advance one write at a time. */
  private controlChain: Promise<unknown> = Promise.resolve()

  constructor(
    host: string,
    port = 5683,
    private readonly options: PhilipsCoapClientOptions = {},
  ) {
    this.socket = new CoapSocket(host, port)
  }

  async getInfo(): Promise<DeviceInfo> {
    this.requireOpen()
    try {
      const response = await this.socket.request({ method: 'GET', path: INFO_PATH })
      this.requireOpen()
      return DeviceInfoSchema.parse(JSON.parse(response.payload.toString()))
    } catch (error) {
      this.requireOpen()
      throw error
    }
  }

  async connect(timeoutMs?: number): Promise<void> {
    this.requireOpen()
    const nonce = randomBytes(4).toString('hex').toUpperCase()
    try {
      const response = await this.socket.request({ method: 'POST', path: SYNC_PATH, payload: nonce, timeoutMs })
      this.requireOpen()
      this.clientKey = response.payload.toString().trim()
    } catch (error) {
      this.requireOpen()
      throw error
    }
  }

  private requireKey(): string {
    if (!this.clientKey) throw new NotConnectedError()
    return this.clientKey
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('client closed')
  }

  private parseStatus(message: DecodedCoapMessage): DeviceStatus {
    return parseStatusPayload(decrypt(message.payload.toString()))
  }

  async getStatus(): Promise<{ status: DeviceStatus, maxAge: number }> {
    this.requireOpen()
    this.requireKey()
    let observation: Observation | undefined
    try {
      observation = await this.socket.observe({
        path: STATUS_PATH,
        onNotify: () => {},
        allowQuiet: this.options.quietObserve === true,
      })
      this.requireOpen()
      if (!observation.first) throw new NoInitialStatusError()
      const maxAgeOption = findOption(observation.first.options, CoapOption.MaxAge)
      const maxAge = maxAgeOption ? bufferToUint(maxAgeOption.value) : DEFAULT_MAX_AGE
      return {
        status: this.parseStatus(observation.first),
        maxAge: maxAge > 0 ? maxAge : DEFAULT_MAX_AGE,
      }
    } catch (error) {
      this.requireOpen()
      throw error
    } finally {
      observation?.cancel()
    }
  }

  async *observe(): AsyncGenerator<DeviceStatus> {
    this.requireOpen()
    this.requireKey()
    const queue: DeviceStatus[] = []
    let failure: Error | undefined
    let wake: (() => void) | undefined
    const fail = (error: unknown): void => {
      failure = error instanceof Error ? error : new Error(String(error))
      wake?.()
      wake = undefined
    }
    const enqueue = (message: DecodedCoapMessage): void => {
      try {
        queue.push(this.parseStatus(message))
        wake?.()
        wake = undefined
      } catch (error) {
        // Some Philips firmware occasionally emits a same-token Observe packet
        // that is not an encrypted status blob. Dropping one malformed packet is
        // safer than tearing down an otherwise healthy long-lived observation.
        if (this.options.ignoreMalformedObservePushes === true && error instanceof MalformedPayloadError) return
        fail(error)
      }
    }

    let observation: Observation
    try {
      observation = await this.socket.observe({
        path: STATUS_PATH,
        onNotify: enqueue,
        onError: fail,
        allowQuiet: this.options.quietObserve === true,
      })
    } catch (error) {
      this.requireOpen()
      throw error
    }
    if (this.closed) {
      observation.cancel()
      this.requireOpen()
    }
    this.observations.add(observation)
    this.observationFailures.set(observation, fail)

    try {
      if (observation.first) yield this.parseStatus(observation.first)
      while (true) {
        if (failure) throw failure
        if (queue.length) {
          yield queue.shift()!
          continue
        }
        await new Promise<void>(resolve => {
          wake = resolve
          if (failure || queue.length) {
            wake = undefined
            resolve()
          }
        })
      }
    } finally {
      this.observationFailures.delete(observation)
      if (this.observations.delete(observation)) observation.cancel()
    }
  }

  /**
   * Re-register every live long-lived Observe using its existing token.
   *
   * This is deliberately separate from {@link observe}: callers that never ask
   * for revalidation retain exactly the existing observation behaviour.
   * Temporary observations created by {@link getStatus} are not included.
   */
  refreshObservations(): number {
    this.requireOpen()
    for (const observation of this.observations) observation.refresh()
    return this.observations.size
  }

  /**
   * Control writes advance a rolling key, so two concurrent writes (HAP sends Active and
   * RotationSpeed as one PUT, invoking both onSet handlers at once) would emit K+1 and K+2
   * as separate NON datagrams that UDP may reorder — the device then rejects the stale one.
   * Queue them instead. A rejected write never poisons the chain, and close() still lands:
   * the queued call's own requireOpen() rejects it.
   * ponytail: each queued write gets its own budgetMs from the moment it starts, so a
   * device that burns the full ~6s can push the second write past HAP's 10s timeout.
   * Acceptable — that device is already failing. Share a deadline if it ever matters.
   */
  async setControl(
    values: Record<string, unknown>,
    options: SetControlOptions = {},
  ): Promise<boolean> {
    this.requireOpen()
    const write = this.controlChain.then(() => this.writeControl(values, options))
    this.controlChain = write.catch(() => {})
    return write
  }

  private async writeControl(
    values: Record<string, unknown>,
    options: SetControlOptions,
  ): Promise<boolean> {
    this.requireOpen()
    const {
      retries = 5,
      retryDelayMs = 500,
      resync = true,
      timeoutMs = 2000,
      budgetMs = 6000,
    } = options
    this.requireKey()
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

    // Every wait below is clamped to what's left of this deadline, so the whole
    // loop — regardless of how `retries` is configured — never runs longer than
    // budgetMs. That keeps a single onSet() well inside HAP-NodeJS's ~10s write
    // timeout instead of hammering an unresponsive device for tens of seconds.
    const deadline = Date.now() + budgetMs

    for (let attempt = 0; attempt <= retries; attempt++) {
      this.requireOpen()
      const requestBudget = deadline - Date.now()
      if (requestBudget <= 0) break
      try {
        this.clientKey = nextKey(this.requireKey())
        const response = await this.socket.request({
          method: 'POST',
          path: CONTROL_PATH,
          payload: encrypt(this.clientKey, payload),
          timeoutMs: Math.min(timeoutMs, requestBudget),
        })
        this.requireOpen()
        if (JSON.parse(response.payload.toString()).status === 'success') return true
      } catch {
        this.requireOpen()
        // A timeout, malformed response, or rejected write is retryable.
      }

      if (attempt === retries) break
      const resyncBudget = deadline - Date.now()
      if (resyncBudget <= 0) break
      if (resync) {
        try {
          await this.connect(Math.min(timeoutMs, resyncBudget))
        } catch {
          this.requireOpen()
          // A failed resync is retryable too: keep the stale key and let the next
          // attempt's own resync try again, still bounded by the deadline below.
        }
      }
      const delayBudget = deadline - Date.now()
      if (delayBudget <= 0) break
      await new Promise(resolve => setTimeout(resolve, Math.min(retryDelayMs, delayBudget)))
    }

    return false
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const observation of this.observations) {
      this.observationFailures.get(observation)?.(new Error('client closed'))
      observation.cancel()
    }
    this.observations.clear()
    this.observationFailures.clear()
    setImmediate(() => this.socket.close())
  }
}
