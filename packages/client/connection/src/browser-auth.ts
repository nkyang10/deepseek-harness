/**
 * Browser pairing and per-device session cookies for the Host Connection carrier.
 *
 * A browser obtains a session by exchanging the durable pairing code in a
 * shared link, or by submitting the owner-configured passcode on the served
 * login page. The pairing code lives in the harness credential store beside the
 * cookie signing secret, so a link handed to a phone keeps working across Host
 * restarts until its owner rotates it. Every browser that pairs becomes a
 * listed session holding its own opaque id, and the signed cookie names that
 * id. Revoking a session drops the id, so each cookie naming it stops verifying
 * at once — without disturbing another session and without invalidating either
 * credential itself.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { CONNECT_PATH, type ConnectionInteractions } from './connect-protocol.ts'
import type {
  BrowserDeviceId,
  BrowserSession,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const DEVICE_ID_BYTES = 9
const MAX_USER_AGENT_CHARS = 256
const PAIRING_QUERY = 'token'
const COOKIE_PREFIX = 'dsh-auth-'
/** Browser cookie carrying a paired session; the pre-session payload no longer verifies. */
const COOKIE_PAYLOAD_VERSION = 3
/** API cookie carrying the Peer minted for one `/connect` exchange. */
const API_COOKIE_VERSION = 2
/** Stored record carrying the signing secret, the pairing code, and the session list. */
const STORED_SESSION_VERSION = 2
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const PASSCODE_FIELD = 'passcode'
const PASSCODE_FORM_TYPE = 'application/x-www-form-urlencoded'
const PASSCODE_BODY_MAX_CHARS = 4_096
/** Fixed abuse bounds for the human-chosen passcode; neither is deployment-tunable. */
const PASSCODE_MAX_FAILURES = 10
const PASSCODE_BLOCK_MILLISECONDS = 60_000

/** No-script/no-frame CSP for every served login page. */
const LOGIN_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"

/** Read-only passcode reference; the Loader's volatile config field satisfies it. */
export interface PasscodeSource {
  /** @returns the current passcode, or undefined when the owner has not set one. */
  get(): string | undefined
}

/** Consecutive failed passcode submissions for one peer, and the resulting block. */
interface PasscodeAttemptState {
  failures: number
  blockedUntil: number
}

/** Live session table plus the two secrets that authenticate it. */
interface SessionStore {
  /** HMAC key signing every session cookie. */
  readonly secret: Buffer
  /** Durable code a browser exchanges for a session. */
  readonly pairing: string
  /** Unrevoked sessions by id, in pairing order; touches replace rows in place. */
  readonly sessions: Map<BrowserDeviceId, BrowserSession>
}

/** The credential record's payload, as written to the harness home. */
interface StoredSessionPayload {
  readonly version: typeof STORED_SESSION_VERSION
  readonly secret: string
  readonly pairing: string
  readonly sessions: readonly BrowserSession[]
}

/** The browser cookie's payload: which authority and which paired browser. */
interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly device: BrowserDeviceId
  readonly issuedAt: number
  readonly expiresAt: number
}

/** The API cookie's payload: which authority and which Peer the `/connect` exchange minted. */
interface ApiCookiePayload {
  readonly version: typeof API_COOKIE_VERSION
  readonly authority: string
  readonly id: PeerId
  readonly issuedAt: number
  readonly expiresAt: number
}

type CookiePayload = BrowserCookiePayload | ApiCookiePayload

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Protocol-scoped cookie audience; HTTP retains its existing authority-only spelling. */
function requestAudience(headers: ConnectionTrustRequest['headers'], secure: boolean): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${host}`)
    return secure ? url.origin : url.host
  } catch {
    return undefined
  }
}

/** One fresh pairing code, shaped like the signing secret it shares a record with. */
function newPairingCode(): string {
  return encodeBase64Url(randomBytes(SECRET_BYTES))
}

function newDeviceId(): BrowserDeviceId {
  return brandString<BrowserDeviceId>(encodeBase64Url(randomBytes(DEVICE_ID_BYTES)))
}

/** The `User-Agent` a pairing request presented, bounded for durable storage. */
function presentedUserAgent(headers: ConnectionTrustRequest['headers']): string {
  return (header(headers, 'user-agent') ?? '').slice(0, MAX_USER_AGENT_CHARS)
}

/** Compare two secrets without leaking their common prefix length through timing. */
function codeMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

/** Rejection naming the record this plugin owns, for any unreadable stored shape. */
function unsupportedRecordError(): Error {
  return new Error('client-connection: browser-session credential record has an unsupported format')
}

/** Rejection for a session change attempted after the record was removed under a running Host. */
function missingRecordError(): Error {
  return new Error('client-connection: browser-session credential record is missing; restart the Host to recreate it')
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  return decoded !== undefined && decoded.byteLength === SECRET_BYTES ? decoded : undefined
}

function canonicalDeviceId(value: unknown): BrowserDeviceId | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  return decoded !== undefined && decoded.byteLength === DEVICE_ID_BYTES
    ? brandString<BrowserDeviceId>(value)
    : undefined
}

/**
 * Read one stored session row. Every field is checked because the record is a
 * durable file a user can edit: a row that cannot be read exactly is refused
 * rather than silently dropped, so a damaged record never reads as a revoked
 * browser or an unbounded session.
 * @param value - one element of the stored `sessions` array.
 * @returns the session, or undefined when any field is absent or misshapen.
 */
function storedSession(value: unknown): BrowserSession | undefined {
  if (!isRecord(value)) return undefined
  const id = canonicalDeviceId(value.id)
  const { userAgent, pairedAt, lastSeenAt, expiresAt } = value
  if (id === undefined || typeof userAgent !== 'string'
    || typeof pairedAt !== 'number' || !Number.isSafeInteger(pairedAt)
    || typeof lastSeenAt !== 'number' || !Number.isSafeInteger(lastSeenAt)
    || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)
    || expiresAt <= pairedAt) return undefined
  return {
    id,
    userAgent,
    pairedAt,
    lastSeenAt,
    expiresAt,
  }
}

/**
 * Read the stored session table.
 *
 * A version 1 record holds only the signing secret. Its secret is kept, so
 * cookies minted before sessions existed stop verifying — they name no device —
 * while the pairing code and an empty session list are written alongside it.
 * @param record - the stored credential record, absent when none exists.
 * @returns the live store, or undefined when no record is stored.
 * @throws when a stored record is present but unreadable.
 */
function storedStore(record: CredentialRecord | undefined): SessionStore | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)) throw unsupportedRecordError()
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) throw unsupportedRecordError()
  if (record.payload.version !== STORED_SESSION_VERSION) {
    return { secret, pairing: newPairingCode(), sessions: new Map() }
  }
  const pairing = record.payload.pairing
  const sessions = record.payload.sessions
  if (typeof pairing !== 'string' || canonicalSecret(pairing) === undefined || !Array.isArray(sessions)) {
    throw unsupportedRecordError()
  }
  const table = new Map<BrowserDeviceId, BrowserSession>()
  for (const row of sessions) {
    const session = storedSession(row)
    if (session === undefined || table.has(session.id)) throw unsupportedRecordError()
    table.set(session.id, session)
  }
  return { secret, pairing, sessions: table }
}

/** Serialize a store back into its credential record payload. */
function renderPayload(store: SessionStore): StoredSessionPayload {
  return {
    version: STORED_SESSION_VERSION,
    secret: encodeBase64Url(store.secret),
    pairing: store.pairing,
    sessions: [...store.sessions.values()],
  }
}

/** Whether a stored record already carries the session table, so loading can decline the write. */
function isCurrentRecord(record: CredentialRecord | undefined): boolean {
  return record?.kind === 'grant' && isRecord(record.payload)
    && record.payload.version === STORED_SESSION_VERSION
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(
  name: string,
  value: string,
  expiresAt: number,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attributes = `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
  return secure ? `${attributes}; Secure` : attributes
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: CookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v${String(payload.version)}.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): CookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version === undefined || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || (decoded.version !== COOKIE_PAYLOAD_VERSION && decoded.version !== API_COOKIE_VERSION)
    || version !== `v${String(decoded.version)}`
    || typeof decoded.authority !== 'string'
    || typeof decoded.issuedAt !== 'number' || !Number.isSafeInteger(decoded.issuedAt)
    || typeof decoded.expiresAt !== 'number' || !Number.isSafeInteger(decoded.expiresAt)
    || decoded.expiresAt <= decoded.issuedAt) return undefined
  const common = { authority: decoded.authority, issuedAt: decoded.issuedAt, expiresAt: decoded.expiresAt }
  if (decoded.version === COOKIE_PAYLOAD_VERSION) {
    const device = canonicalDeviceId(decoded.device)
    return device === undefined ? undefined : { version: COOKIE_PAYLOAD_VERSION, device, ...common }
  }
  if (typeof decoded.id !== 'string' || decoded.id.length === 0) return undefined
  return { version: API_COOKIE_VERSION, id: decoded.id as PeerId, ...common }
}

/** Drop sessions whose absolute lifetime has passed, keeping the table honest. */
function liveSessions(sessions: ReadonlyMap<BrowserDeviceId, BrowserSession>): Map<BrowserDeviceId, BrowserSession> {
  const now = Date.now()
  return new Map([...sessions].filter(([, session]) => session.expiresAt > now))
}

/**
 * Create or adopt the browser-session store, then own pairing, verification, and
 * session management over it.
 *
 * Connection loads the pairing code and the session table during activation and
 * retains them for synchronous request authentication; pairing, revocation, and
 * code rotation read the credential store again on every change.
 */
export class BrowserAuth {
  private readonly maxAgeMilliseconds: number
  private readonly passcodeAttempts = new Map<string, PasscodeAttemptState>()

  private constructor(
    private store: SessionStore,
    private readonly credentials: CredentialProvider,
    maxAgeDays: number,
    private readonly passcode: PasscodeSource | undefined,
  ) {
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(this.maxAgeMilliseconds)
      || !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
  }

  /**
   * Initialize browser authentication and adopt or create the durable session store.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days, measured from pairing.
   * @param passcode - optional owner-configured login passcode shared with the served page.
   * @returns initialized authentication owner over the stored pairing code and sessions.
   */
  static async create(
    credentials: CredentialProvider,
    maxAgeDays: number,
    passcode?: PasscodeSource,
  ): Promise<BrowserAuth> {
    const stored = await BrowserAuth.initializeStore(credentials)
    return new BrowserAuth(stored, credentials, maxAgeDays, passcode)
  }

  /**
   * Load the session store, creating it or upgrading a record that predates sessions.
   * @param credentials - persistent credential provider for the Web profile.
   * @returns the adopted store, which is durable once this resolves.
   */
  private static async initializeStore(credentials: CredentialProvider): Promise<SessionStore> {
    const record = await credentials.modifyRecord(AUTH_RECORD_KEY, async (current) => {
      if (isCurrentRecord(current)) return Promise.resolve(undefined)
      const store = storedStore(current) ?? {
        secret: randomBytes(SECRET_BYTES),
        pairing: newPairingCode(),
        sessions: new Map<BrowserDeviceId, BrowserSession>(),
      }
      return Promise.resolve({ kind: 'grant', payload: renderPayload(store) })
    })
    const store = storedStore(record)
    if (store === undefined) {
      throw new Error('client-connection: browser-session credential record was not created')
    }
    return store
  }

  /**
   * Add this deployment's pairing code to the caller's application URL. Whoever
   * opens the result becomes a new listed session.
   * @param baseUrl - clean browser URL whose authority and mount are preserved.
   * @returns the same URL carrying the pairing code as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.searchParams.set(PAIRING_QUERY, this.store.pairing)
    return url.href
  }

  /**
   * Authenticate an index request. A valid root query code pairs the browser and
   * mints its cookie, then redirects to the directory-relative clean `./`; a valid
   * cookie lets the caller serve the index; a form POST that carries no configured
   * passcode receives the minimal 401 text response, and every other unauthenticated
   * request receives a login page.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @param secure - whether the listener receiving this request serves TLS; the
   * minted cookie carries `Secure` when it does. Only that listener's own
   * protocol decides, never a `publicUrl` announcement or a forwarded header:
   * those describe a hop this process does not terminate.
   * @returns true only when the caller may serve index.html.
   */
  async authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse, secure = false): Promise<boolean> {
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const codes = url.searchParams.getAll(PAIRING_QUERY)
    if (codes.length > 0) {
      const authority = requestAudience(req.headers, secure)
      if (req.method === 'GET' && url.pathname === '/' && codes.length === 1
        && authority !== undefined && codeMatches(codes.join(''), this.store.pairing)) {
        await this.pair(req, authority, res, secure)
        return false
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req, secure)) {
        this.writeRedirect(res)
        return false
      }
      this.writeIndexUnauthorized(req, res)
      return false
    }
    if (this.isAuthenticated(req, secure)) return true
    if (req.method === 'POST') {
      await this.authorizePasscode(req, res, secure)
      return false
    }
    this.writeIndexUnauthorized(req, res)
    return false
  }

  /**
   * Authenticate one passcode form submission. A matching passcode pairs the
   * browser and redirects exactly like the shared link; a miss renders the form
   * again with a bounded, per-peer retry policy. Requests without a configured
   * passcode receive the ordinary unauthenticated response.
   * @param req - POST index request carrying the form body.
   * @param res - response owned to completion.
   * @param secure - whether the receiving listener serves TLS.
   */
  private async authorizePasscode(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    secure: boolean,
  ): Promise<void> {
    const passcode = this.configuredPasscode()
    if (passcode === undefined) {
      this.writeUnauthorized(req, res)
      return
    }
    const authority = requestAudience(req.headers, secure)
    const key = req.remoteAddress ?? authority ?? 'unknown'
    const blockedUntil = this.blockedUntil(key)
    if (blockedUntil !== undefined) {
      this.writePasscodePage(req, res, 429, 'tooMany', blockedUntil)
      return
    }
    if (authority === undefined
      || header(req.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== PASSCODE_FORM_TYPE
      || req.body === undefined || req.body.length > PASSCODE_BODY_MAX_CHARS) {
      this.writePasscodePage(req, res, 400, 'badRequest')
      return
    }
    const submitted = new URLSearchParams(req.body).get(PASSCODE_FIELD)
    if (submitted === null) {
      this.writePasscodePage(req, res, 400, 'badRequest')
      return
    }
    if (codeMatches(submitted, passcode)) {
      this.passcodeAttempts.delete(key)
      await this.pair(req, authority, res, secure)
      return
    }
    this.recordPasscodeFailure(key)
    this.writePasscodePage(req, res, 401, 'incorrect')
  }

  /** @returns the passcode when the owner configured a non-empty one, or undefined. */
  private configuredPasscode(): string | undefined {
    const value = this.passcode?.get()
    return value === undefined || value.length === 0 ? undefined : value
  }

  /** @returns the end of the active block for `key`, or undefined when attempts may proceed. */
  private blockedUntil(key: string): number | undefined {
    const state = this.passcodeAttempts.get(key)
    if (state === undefined) return undefined
    if (state.blockedUntil > Date.now()) return state.blockedUntil
    if (state.blockedUntil !== 0) this.passcodeAttempts.delete(key)
    return undefined
  }

  /** Count one failed submission, blocking this peer after the fixed threshold. */
  private recordPasscodeFailure(key: string): void {
    const now = Date.now()
    const state = this.passcodeAttempts.get(key) ?? { failures: 0, blockedUntil: 0 }
    state.failures += 1
    if (state.failures >= PASSCODE_MAX_FAILURES) state.blockedUntil = now + PASSCODE_BLOCK_MILLISECONDS
    this.passcodeAttempts.set(key, state)
    for (const [candidate, entry] of this.passcodeAttempts) {
      if (candidate !== key && entry.blockedUntil !== 0 && entry.blockedUntil <= now) {
        this.passcodeAttempts.delete(candidate)
      }
    }
  }

  /**
   * Verify the authority-bound session cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS, including its default port.
   * @returns true only for a cookie naming an unexpired session this activation holds.
   */
  isAuthenticated(request: ConnectionTrustRequest, secure = false): boolean {
    const session = this.authenticatedSession(request, secure)
    if (session === undefined) return false
    // The session table is durable on the next store write; a request must not
    // wait on the credential file, so the touch is published in memory first.
    this.store.sessions.set(session.id, { ...session, lastSeenAt: Date.now() })
    return true
  }

  /**
   * List the paired browsers, dropping expired sessions and writing back any
   * last-seen updates this activation collected while answering requests.
   * @returns the live sessions in pairing order.
   */
  async listSessions(): Promise<readonly BrowserSession[]> {
    await this.persist(store => ({ ...store, sessions: liveSessions(store.sessions) }))
    return [...this.store.sessions.values()]
  }

  /**
   * End one paired browser's access. Every cookie naming that session stops
   * verifying immediately; other sessions and the pairing code are untouched.
   * @param id - the session to revoke.
   */
  async revokeSession(id: BrowserDeviceId): Promise<void> {
    await this.persist((store) => {
      const sessions = new Map(store.sessions)
      sessions.delete(id)
      return { ...store, sessions }
    })
  }

  /**
   * Replace the pairing code. Links carrying the previous code stop pairing new
   * browsers, while already paired browsers keep their sessions.
   */
  async rotatePairingCode(): Promise<void> {
    await this.persist(store => ({ ...store, pairing: newPairingCode() }))
  }

  /**
   * The live session a request's cookie names. A `/connect` API cookie names no
   * paired browser, so only the browser payload resolves to a session.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS, including its default port.
   * @returns the session, or undefined when the cookie does not verify or its session is gone or expired.
   */
  private authenticatedSession(request: ConnectionTrustRequest, secure: boolean): BrowserSession | undefined {
    const payload = this.authenticate(request, secure)
    if (payload?.version !== COOKIE_PAYLOAD_VERSION) return undefined
    const session = this.store.sessions.get(payload.device)
    // The session row is the browser's authority on lifetime: the cookie repeats
    // it for the verifier's convenience, and a configuration that shortened the
    // window after pairing does not retroactively cut a paired browser off.
    return session !== undefined && session.expiresAt > Date.now() ? session : undefined
  }

  /**
   * Verify the authority-bound cookie on a Host request, whether it names a
   * paired browser or a `/connect` Peer.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS, including its default port.
   * @returns the signed payload, or undefined for invalid, expired, or wrong-authority cookies.
   */
  private authenticate(request: ConnectionTrustRequest, secure: boolean): CookiePayload | undefined {
    const authority = requestAudience(request.headers, secure)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return undefined
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return undefined
    const payload = decodeCookie(value, this.store.secret)
    if (payload === undefined || payload.authority !== authority) return undefined
    const now = Date.now()
    if (payload.issuedAt > now || payload.expiresAt <= now) return undefined
    // A `/connect` Peer carries its own signed lifetime and no session row, so
    // only that payload is bounded by the configured maximum.
    if (payload.version === API_COOKIE_VERSION
      && payload.expiresAt - payload.issuedAt > this.maxAgeMilliseconds) return undefined
    return payload
  }

  /**
   * Exchange the pairing code for an independent API Peer; omitted interactions default to none.
   * @param req - trusted GET request on /connect with at most one interactions declaration.
   * @param res - response owned to completion, redirecting to the API mux on success.
   * @param secure - whether the receiving listener serves TLS.
   * @param publish - synchronously create the Peer before exposing its signed credential.
   */
  authorizeConnect(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    secure: boolean,
    publish: (interactions: ConnectionInteractions) => PeerId,
  ): void {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const declarations = url.searchParams.getAll('interactions')
    const interactions = declarations[0] ?? 'none'
    if (declarations.length > 1 || (interactions !== 'answer' && interactions !== 'none')) {
      res.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      res.end('interactions must be declared once as answer or none\n')
      return
    }
    const codes = url.searchParams.getAll(PAIRING_QUERY)
    const authority = requestAudience(req.headers, secure)
    if (req.method !== 'GET' || url.pathname !== CONNECT_PATH || codes.length !== 1
      || authority === undefined || !codeMatches(codes.join(''), this.store.pairing)) {
      this.writeUnauthorized(req, res)
      return
    }
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const id = publish(interactions)
    const value = encodeCookie({ version: API_COOKIE_VERSION, authority, id, issuedAt, expiresAt }, this.store.secret)
    res.writeHead(302, {
      'cache-control': 'no-store',
      'location': './api/remote.mux',
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(
        cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000), secure,
      ),
    })
    res.end()
  }

  /**
   * Verify an API credential without creating or reviving its Peer.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS.
   * @returns the signed Peer id, or undefined for invalid, expired, or browser cookies.
   */
  authenticateApi(request: ConnectionTrustRequest, secure = false): PeerId | undefined {
    const payload = this.authenticate(request, secure)
    return payload?.version === API_COOKIE_VERSION ? payload.id : undefined
  }

  /**
   * Record one browser pairing and answer it with its session cookie. A browser
   * that already holds a session for this authority keeps its identity and
   * pairing time and only has its lifetime refreshed; any other browser becomes
   * a new listed session.
   * @param req - the authenticated pairing request.
   * @param authority - the audience its cookie is bound to.
   * @param res - response owned by this call.
   * @param secure - whether the listener receiving this request serves TLS.
   */
  private async pair(
    req: ConnectionIndexRequest,
    authority: string,
    res: ConnectionIndexResponse,
    secure: boolean,
  ): Promise<void> {
    const now = Date.now()
    const existing = this.authenticatedSession(req, secure)
    const session: BrowserSession = {
      id: existing?.id ?? newDeviceId(),
      userAgent: presentedUserAgent(req.headers),
      pairedAt: existing?.pairedAt ?? now,
      lastSeenAt: now,
      expiresAt: now + this.maxAgeMilliseconds,
    }
    await this.persist(store => ({
      ...store,
      sessions: new Map(store.sessions).set(session.id, session),
    }))
    const maxAgeSeconds = Math.floor(this.maxAgeMilliseconds / 1000)
    res.writeHead(303, {
      'cache-control': 'no-store',
      'location': './',
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(
        cookieName(authority),
        encodeCookie({
          version: COOKIE_PAYLOAD_VERSION,
          authority,
          device: session.id,
          issuedAt: session.pairedAt,
          expiresAt: session.expiresAt,
        }, this.store.secret),
        session.expiresAt,
        maxAgeSeconds,
        secure,
      ),
    })
    res.end()
  }

  private writeRedirect(res: ConnectionIndexResponse): void {
    res.writeHead(303, {
      'cache-control': 'no-store',
      'location': './',
      'referrer-policy': 'no-referrer',
    })
    res.end()
  }

  /**
   * Apply one change to the session store and adopt the result. The transform
   * reads the record as it stands inside the credential store's exclusion, so a
   * concurrent pairing or revocation in another process is merged rather than
   * overwritten.
   * @param transform - the change to apply to the stored store.
   */
  private async persist(transform: (store: SessionStore) => SessionStore): Promise<void> {
    const record = await this.credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
      const store = storedStore(current)
      if (store === undefined) return Promise.reject(missingRecordError())
      return Promise.resolve({ kind: 'grant', payload: renderPayload(transform(this.withObservedActivity(store))) })
    })
    const stored = storedStore(record)
    if (stored === undefined) throw missingRecordError()
    this.store = stored
  }

  /**
   * Fold this activation's last-seen observations into a store read back from
   * the credential file. A touch is a local observation that only ever moves
   * forward, so the newer of the two values wins, while the file stays the
   * source of every structural change.
   * @param store - the store as the credential file currently holds it.
   * @returns the same store carrying this activation's newer activity marks.
   */
  private withObservedActivity(store: SessionStore): SessionStore {
    const sessions = new Map(store.sessions)
    for (const [id, session] of sessions) {
      const observed = this.store.sessions.get(id)
      if (observed !== undefined && observed.lastSeenAt > session.lastSeenAt) {
        sessions.set(id, { ...session, lastSeenAt: observed.lastSeenAt })
      }
    }
    return { ...store, sessions }
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; pair again from the application that serves this page.\n')
  }

  /**
   * Respond to an unauthenticated index request. With an owner passcode the
   * visitor receives the passcode login page; without one they receive a
   * self-contained sign-in page naming the pairing link and the passcode option.
   * A form POST keeps the plain-text response the passcode form and API clients
   * expect.
   * @param req - index request already known to be unauthenticated.
   * @param res - response owned by this call.
   */
  private writeIndexUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    if (req.method === 'POST') {
      this.writeUnauthorized(req, res)
      return
    }
    this.writeLoginPage(req, res, 401,
      this.configuredPasscode() === undefined ? signInRequiredPage() : passcodePage())
  }

  /**
   * Send a fixed login document with the shared login CSP. A HEAD request
   * receives the headers without the body.
   * @param req - request whose method decides whether a body is written.
   * @param res - response owned by this call.
   * @param status - status line for this page.
   * @param document - fixed login document; no request data reaches the markup.
   * @param blockedUntil - end of the active block, written as `Retry-After`.
   */
  private writeLoginPage(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    status: number,
    document: string,
    blockedUntil?: number,
  ): void {
    const headers: Record<string, string> = {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': LOGIN_PAGE_CSP,
      'referrer-policy': 'no-referrer',
    }
    if (blockedUntil !== undefined) {
      headers['retry-after'] = String(Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000)))
    }
    res.writeHead(status, headers)
    res.end(req.method === 'HEAD' ? undefined : document)
  }

  /**
   * Render the passcode login page. The page is a fixed document; the only
   * variable is a closed error token, so no request data reaches the markup.
   * @param req - request whose method decides whether a body is written.
   * @param res - response owned by this call.
   * @param status - status line for this page.
   * @param error - closed error code shown above the form.
   * @param blockedUntil - end of the active block, written as `Retry-After`.
   */
  private writePasscodePage(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    status: number,
    error?: 'incorrect' | 'tooMany' | 'badRequest',
    blockedUntil?: number,
  ): void {
    this.writeLoginPage(req, res, status, passcodePage(error), blockedUntil)
  }
}

/** Closed error copy for the login page. */
function passcodeError(error: 'incorrect' | 'tooMany' | 'badRequest'): string {
  switch (error) {
    case 'incorrect': return '<p class="error" role="alert">Incorrect passcode. Try again.</p>'
    case 'tooMany': return '<p class="error" role="alert">Too many attempts. Try again in a minute.</p>'
    case 'badRequest': return '<p class="error" role="alert">The passcode form was not submitted correctly.</p>'
  }
}

/** Shared stylesheet for every served login page. */
const LOGIN_CSS = `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f6f7; color: #1f2328;
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: min(360px, calc(100vw - 32px)); padding: 28px; border-radius: 14px; background: #fff;
  box-shadow: 0 12px 32px rgb(0 0 0 / 10%); }
h1 { margin: 0 0 8px; font-size: 20px; line-height: 1.3; }
p { margin: 0 0 20px; color: #57606a; }
label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; }
input { width: 100%; height: 40px; padding: 0 12px; border: 1px solid #d0d7de; border-radius: 8px;
  background: #fff; color: inherit; font: inherit; }
input:focus { outline: 2px solid #0969da; outline-offset: 0; border-color: #0969da; }
button { width: 100%; height: 40px; margin-top: 14px; border: 0; border-radius: 8px; background: #1f883d;
  color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
.error { margin: 0 0 16px; color: #cf222e; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #e6edf3; }
  main { background: #161b22; box-shadow: 0 12px 32px rgb(0 0 0 / 45%); }
  p { color: #9198a1; }
  input { border-color: #30363d; background: #0d1117; }
  button { background: #238636; }
  .error { color: #f85149; }
}
`

/**
 * Assemble one self-contained login document: no scripts, frames, or external
 * requests, so it renders identically on a locked-down device.
 * @param title - document title, a closed constant that never carries request data.
 * @param body - the `<main>` content.
 * @returns a complete HTML document.
 */
function loginDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
${LOGIN_CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`
}

/**
 * Login document for a deployment whose owner configured a passcode.
 * @param error - closed error code, or undefined on the first visit.
 * @returns a self-contained HTML page posting back to the same directory.
 */
function passcodePage(error?: 'incorrect' | 'tooMany' | 'badRequest'): string {
  return loginDocument('DeepSeek Harness — passcode required', `  <h1>Enter passcode</h1>
  <p>This DeepSeek Harness Web deployment is protected by a passcode.</p>
  ${error === undefined ? '' : passcodeError(error)}
  <form method="post" action="./">
    <label for="passcode">Passcode</label>
    <input id="passcode" name="passcode" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Continue</button>
  </form>`)
}

/**
 * Login document for a deployment with no owner passcode. It directs the visitor
 * to the pairing link the application shows and names the passcode as the option
 * the owner can enable to sign in from this page directly.
 * @returns a self-contained HTML page with no form.
 */
function signInRequiredPage(): string {
  return loginDocument('DeepSeek Harness — sign in required', `  <h1>Open the app to sign in</h1>
  <p>This DeepSeek Harness Web deployment is protected. Open DeepSeek Harness on the host machine and use its pairing link to sign in on this device.</p>
  <p>The owner can also enable a passcode, which lets you sign in from this page.</p>`)
}
