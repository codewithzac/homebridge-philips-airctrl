import { createSocket, type Socket } from 'node:dgram'
import { randomBytes, randomInt } from 'node:crypto'
import { isIP } from 'node:net'
import { debuglog } from 'node:util'
import {
  CoapCode,
  CoapOption,
  CoapType,
  type DecodedCoapMessage,
  decode,
  encode,
  uintToBuffer,
  uriPathOptions,
} from './message.js'

const DEFAULT_TIMEOUT_MS = 8000

// Enable with NODE_DEBUG=philips-air:coap-socket.
const debug = debuglog('philips-air:coap-socket')

export interface RequestOptions {
  method: 'GET' | 'POST'
  path: string
  payload?: string | Buffer
  timeoutMs?: number
}

export interface ObserveOptions {
  path: string
  onNotify: (message: DecodedCoapMessage) => void
  onError?: (error: Error) => void
  timeoutMs?: number
  /**
   * Some Philips firmware accepts an Observe registration but sends no initial
   * notification. When true, initial silence resolves as a live observation
   * instead of tearing the subscription down.
   */
  allowQuiet?: boolean
}

export interface Observation {
  first?: DecodedCoapMessage
  /** Proactively deregister: same token, Observe = 1. */
  cancel: () => void
}

/**
 * A UDP socket speaking just enough CoAP for Philips devices.
 *
 * Responses are matched to requests by TOKEN, not message ID. Observe
 * notifications reuse the original request's token but carry fresh message IDs,
 * so message-ID matching would drop every push.
 */
export class CoapSocket {
  private readonly socket: Socket
  private readonly handlers = new Map<string, (message: DecodedCoapMessage) => void>()
  /** Timeout + reject for each in-flight request/observe-subscribe, so close() can cancel them cleanly. */
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>, reject: (error: Error) => void }>()
  /** onError callbacks for observations past their first response, notified on a socket-level error. */
  private readonly observers = new Map<string, (error: Error) => void>()
  private messageId: number
  private closed = false

  constructor(
    private readonly host: string,
    private readonly port: number = 5683,
  ) {
    this.messageId = randomInt(0, 0x10000)
    this.socket = createSocket('udp4')
    // Unconnected socket: without this check, any host on the network could spoof
    // a reply by guessing the 4-byte token. Only accept datagrams from the device
    // we're actually talking to. When `host` is a hostname rather than a literal IP
    // (e.g. a user hand-edited config.json with "purifier.local"), dgram resolves it
    // to whatever address answers DNS at send time and rinfo.address may not match
    // the literal `host` string, so only the port is checked in that case.
    const hostIsLiteralIp = isIP(this.host) !== 0
    this.socket.on('message', (buffer, rinfo) => {
      if (rinfo.port !== this.port || (hostIsLiteralIp && rinfo.address !== this.host)) {
        debug('dropped datagram from %s:%d (expected %s:%d)', rinfo.address, rinfo.port, this.host, this.port)
        return
      }
      this.dispatch(buffer)
    })
    // A socket-level error must not become an unhandled exception. In-flight
    // requests still fail via their own timeouts; live observations get this
    // error pushed to onError so a dead network doesn't look like a quiet device.
    this.socket.on('error', error => {
      for (const onError of this.observers.values()) onError(error)
    })
    this.socket.unref()
  }

  /** Number of outstanding requests and live observations. Used by tests. */
  get pendingCount(): number {
    return this.handlers.size
  }

  private dispatch(buffer: Buffer): void {
    let message: DecodedCoapMessage
    try {
      message = decode(buffer)
    } catch {
      return // malformed datagram: ignore, never crash the socket
    }
    this.handlers.get(message.token.toString('hex'))?.(message)
  }

  private nextMessageId(): number {
    this.messageId = (this.messageId + 1) & 0xFFFF
    return this.messageId
  }

  private transmit(
    method: 'GET' | 'POST',
    path: string,
    token: Buffer,
    observeValue?: number,
    payload?: string | Buffer,
    onError?: (error: Error) => void,
  ): void {
    if (this.closed) throw new Error('socket is closed')
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
      payload: payload === undefined ? undefined : (Buffer.isBuffer(payload) ? payload : Buffer.from(payload)),
    }), this.port, this.host, error => {
      if (!error) return
      const key = token.toString('hex')
      const pending = this.pending.get(key)
      if (!pending) {
        if (!this.closed) onError?.(error)
        return
      }
      clearTimeout(pending.timer)
      this.handlers.delete(key)
      this.pending.delete(key)
      pending.reject(error)
    })
  }

  /** One request, one response. */
  request(options: RequestOptions): Promise<DecodedCoapMessage> {
    const { method, path, payload, timeoutMs = DEFAULT_TIMEOUT_MS } = options
    return new Promise((resolve, reject) => {
      const token = randomBytes(4)
      const key = token.toString('hex')

      const timer = setTimeout(() => {
        this.handlers.delete(key)
        this.pending.delete(key)
        reject(new Error(`CoAP timeout after ${timeoutMs}ms for ${method} ${path}`))
      }, timeoutMs)
      this.pending.set(key, { timer, reject })

      this.handlers.set(key, message => {
        clearTimeout(timer)
        this.handlers.delete(key)
        this.pending.delete(key)
        resolve(message)
      })

      try {
        this.transmit(method, path, token, undefined, payload)
      } catch (error) {
        clearTimeout(timer)
        this.handlers.delete(key)
        this.pending.delete(key)
        reject(error as Error)
      }
    })
  }

  /** Register an observation. `onNotify` fires for every push after the first. */
  async observe(options: ObserveOptions): Promise<Observation> {
    const { path, onNotify, onError, timeoutMs = DEFAULT_TIMEOUT_MS, allowQuiet = false } = options
    const token = randomBytes(4)
    const key = token.toString('hex')

    const first = await new Promise<DecodedCoapMessage | undefined>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        this.pending.delete(key)
        if (allowQuiet) {
          settled = true
          if (onError) this.observers.set(key, onError)
          resolve(undefined)
          return
        }
        this.handlers.delete(key)
        reject(new Error(`CoAP observe timeout after ${timeoutMs}ms for ${path}`))
      }, timeoutMs)
      this.pending.set(key, { timer, reject })

      this.handlers.set(key, message => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          this.pending.delete(key)
          // Only becomes "live" (eligible for onError) once subscribed.
          if (onError) this.observers.set(key, onError)
          resolve(message)
          return
        }
        onNotify(message)
      })

      try {
        this.transmit('GET', path, token, 0)
      } catch (error) {
        clearTimeout(timer)
        this.handlers.delete(key)
        this.pending.delete(key)
        reject(error as Error)
      }
    })

    return {
      first,
      cancel: () => {
        // Deregister the handler first so a push racing the cancellation is
        // dropped rather than delivered after the caller has stopped listening.
        this.handlers.delete(key)
        this.observers.delete(key)
        if (!this.closed) {
          try {
            this.transmit('GET', path, token, 1, undefined, onError)
          } catch (error) {
            onError?.(error as Error)
          }
        }
      },
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('CoAP socket closed'))
    }
    this.pending.clear()
    this.handlers.clear()
    this.observers.clear()
    try {
      this.socket.close()
    } catch {
      // Already closed.
    }
  }
}
