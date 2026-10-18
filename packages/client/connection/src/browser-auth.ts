/**
 * Browser pairing and per-device session cookies for the Host Connection carrier.
 *
 * A pairing code is the only way a browser obtains a session. The code is
 * durable: it lives in the harness credential store beside the cookie signing
 * secret, so a link handed to a phone keeps working across Host restarts until
 * its owner rotates it. Every browser that exchanges the code becomes a listed
 * session holding its own opaque id, and the signed cookie names that id.
 * Revoking a session drops the id, so each cookie naming it stops verifying at
 * once — without disturbing another session and without invalidating the
 * pairing code itself.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
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
/** Cookie payload carrying a device id; the pre-session payload no longer verifies. */
const COOKIE_PAYLOAD_VERSION = 2
/** Stored record carrying the signing secret, the pairing code, and the session list. */
const STORED_SESSION_VERSION = 2
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

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

/** The signed cookie's payload: which authority and which paired browser. */
interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly device: BrowserDeviceId
}

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

function encodeCookie(payload: BrowserCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): BrowserCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
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
  if (!isRecord(decoded) || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string') return undefined
  const device = canonicalDeviceId(decoded.device)
  if (device === undefined) return undefined
  return { version: COOKIE_PAYLOAD_VERSION, authority: decoded.authority, device }
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

  private constructor(
    private store: SessionStore,
    private readonly credentials: CredentialProvider,
    maxAgeDays: number,
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
   * @returns initialized authentication owner over the stored pairing code and sessions.
   */
  static async create(
    credentials: CredentialProvider,
    maxAgeDays: number,
  ): Promise<BrowserAuth> {
    const stored = await BrowserAuth.initializeStore(credentials)
    return new BrowserAuth(stored, credentials, maxAgeDays)
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
   * cookie lets the caller serve the index; every other request receives the same
   * minimal 401 response.
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
      this.writeUnauthorized(req, res)
      return false
    }
    if (this.isAuthenticated(req, secure)) return true
    this.writeUnauthorized(req, res)
    return false
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
   * The live session a request's cookie names.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS, including its default port.
   * @returns the session, or undefined when the cookie does not verify or its session is gone or expired.
   */
  private authenticatedSession(request: ConnectionTrustRequest, secure: boolean): BrowserSession | undefined {
    const authority = requestAudience(request.headers, secure)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return undefined
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return undefined
    const payload = decodeCookie(value, this.store.secret)
    if (payload === undefined || payload.authority !== authority) return undefined
    const session = this.store.sessions.get(payload.device)
    return session !== undefined && session.expiresAt > Date.now() ? session : undefined
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
        encodeCookie({ version: COOKIE_PAYLOAD_VERSION, authority, device: session.id }, this.store.secret),
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
}
