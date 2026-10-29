/** Browser pairing, per-device session cookies, and revocation behavior. */

import { createHmac, scrypt } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { RecordCredentials } from './browser-credentials.ts'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, scrypt: vi.fn(actual.scrypt) }
})

const scryptMock = vi.mocked(scrypt)

const UNAUTHORIZED_BODY = 'dsh web authentication required; pair again from the application that serves this page.\n'
const LOGIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"

function signedCookie(store: RecordCredentials, name: string, payload: unknown): string {
  const body = typeof payload === 'string'
    ? Buffer.from(payload, 'utf8').toString('base64url')
    : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return signedBodyCookie(store, name, body)
}

function signedBodyCookie(store: RecordCredentials, name: string, body: string, version = 'v1'): string {
  const record = store.record
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('test credential store has no signing secret')
  }
  const secret: unknown = Reflect.get(record.payload, 'secret')
  if (typeof secret !== 'string') throw new Error('test credential record has no string secret')
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
  return `${name}=${version}.${body}.${signature}`
}

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

function createAuth(store: RecordCredentials, maxAgeDays = 30): Promise<BrowserAuth> {
  return BrowserAuth.create(credentials(store), maxAgeDays)
}

function request(url: string, authority = '127.0.0.1:3080', init?: {
  cookie?: string
  method?: string
  userAgent?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
      ...init?.userAgent === undefined ? {} : { 'user-agent': init.userAgent },
    },
  }
}

/** Create authentication over one store and store a verifier for the given passcode. */
async function passcodeAuth(store: RecordCredentials, initial: string | undefined = 'correct-horse'): Promise<BrowserAuth> {
  const auth = await BrowserAuth.create(credentials(store), 30)
  if (initial !== undefined) await auth.setPasscode(initial)
  return auth
}

/** Submit a passcode form, defaulting to the same-authority browser form. */
function submit(init: {
  authority?: string
  remoteAddress?: string
  passcode?: string
  body?: string
  contentType?: string
} = {}): ConnectionIndexRequest {
  const body = init.body ?? (init.passcode === undefined
    ? undefined
    : new URLSearchParams({ passcode: init.passcode }).toString())
  return {
    method: 'POST',
    url: '/',
    ...init.remoteAddress === undefined ? {} : { remoteAddress: init.remoteAddress },
    headers: {
      ...init.authority === undefined ? {} : { host: init.authority },
      'content-type': init.contentType ?? 'application/x-www-form-urlencoded',
      ...init.authority === undefined ? {} : { origin: `http://${init.authority}` },
    },
    ...body === undefined ? {} : { body },
  }
}

/** Exchange the pairing code the way a browser opening the shared link does. */
async function exchange(
  auth: BrowserAuth,
  authority = '127.0.0.1:3080',
  secure = false,
  init?: { cookie?: string; userAgent?: string },
): Promise<{ cookie: string; pairingUrl: string; state: ResponseState }> {
  const pairingUrl = auth.authenticatedUrl(`http://${authority}`)
  const target = new URL(pairingUrl)
  const res = response()
  expect(await auth.authorizeIndex(
    request(`${target.pathname}${target.search}`, authority, init), res.value, secure,
  )).toBe(false)
  const setCookie = res.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('pairing did not set a cookie')
  return { cookie: setCookie.split(';', 1)[0]!, pairingUrl, state: res.state }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('API credentials', () => {
  it('refuses a request without a URL before publishing an API operator', async () => {
    const auth = await createAuth(new RecordCredentials())
    const publish = vi.fn(() => 'api-operator' as PeerId)
    const res = response()

    auth.authorizeConnect({ method: 'GET', headers: { host: 'localhost' } }, res.value, false, publish)

    expect(res.state).toEqual({
      status: 401,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      body: 'dsh web authentication required; pair again from the application that serves this page.\n',
    })

    const head = response()
    auth.authorizeConnect({ method: 'HEAD', headers: { host: 'localhost' } }, head.value, false, publish)
    expect(head.state).toEqual({
      status: 401,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
    })
    expect(publish).not.toHaveBeenCalled()
  })

  it('signs the published id and rejects browser confusion, tampering, audience mismatch, and expiry', async () => {
    vi.useFakeTimers()
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const authority = '127.0.0.1:3080'
    const id = 'api-operator' as PeerId
    const issuedAt = Date.now()
    const publish = vi.fn(() => id)
    const res = response()
    auth.authorizeConnect(request(auth.authenticatedUrl(`http://${authority}/connect`)), {
      ...res.value,
      writeHead(status, headers) {
        expect(publish).toHaveBeenCalledExactlyOnceWith('none')
        return res.value.writeHead(status, headers)
      },
    }, false, publish)
    const cookie = res.state.headers?.['set-cookie']?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('API connect did not set a cookie')
    const [name, value] = cookie.split('=') as [string, string]
    const payload = { version: 2, authority, id, issuedAt, expiresAt: issuedAt + 30 * 86_400_000 }
    expect(JSON.parse(Buffer.from(value.split('.')[1]!, 'base64url').toString('utf8'))).toEqual(payload)
    expect(auth.authenticateApi(request('/', authority, { cookie }))).toBe(id)
    expect(auth.isAuthenticated(request('/', authority, { cookie }))).toBe(false)
    expect(auth.authenticateApi(request('/', authority, { cookie: (await exchange(auth)).cookie }))).toBeUndefined()
    expect(auth.isAuthenticated(request('/', authority, { cookie: cookie.replace('=v2.', '=v1.') }))).toBe(false)
    expect(auth.authenticateApi(request('/', authority, { cookie: `${cookie.slice(0, -1)}!` }))).toBeUndefined()
    expect(auth.authenticateApi(request('/', 'localhost:3080', { cookie }))).toBeUndefined()
    expect(auth.authenticateApi(request('/', '127.0.0.1:3081', { cookie }))).toBeUndefined()
    expect(auth.authenticateApi(request('/', authority, { cookie }), true)).toBeUndefined()
    for (const invalid of [
      { ...payload, version: 3 },
      { ...payload, authority: 'localhost:3080' },
      { ...payload, id: '' },
      { ...payload, id: 42 },
      { ...payload, id: undefined },
      { ...payload, issuedAt: issuedAt + 1 },
      { ...payload, issuedAt: 0.5 },
      { ...payload, expiresAt: 'later' },
      { ...payload, expiresAt: issuedAt - 1 },
    ]) {
      const invalidCookie = signedCookie(store, name, invalid).replace('=v1.', '=v2.')
      expect(auth.authenticateApi(request('/', authority, { cookie: invalidCookie }))).toBeUndefined()
      expect(auth.isAuthenticated(request('/', authority, { cookie: invalidCookie }))).toBe(false)
    }
    const shorter = await createAuth(store, 1)
    expect(shorter.authenticateApi(request('/', authority, { cookie }))).toBeUndefined()
    vi.setSystemTime(payload.expiresAt)
    expect(auth.authenticateApi(request('/', authority, { cookie }))).toBeUndefined()
  })
})

describe('BrowserAuth', () => {
  it('pairs one browser and mints a persistent authority-bound session cookie', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const login = await exchange(auth)

    expect(login.state).toMatchObject({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': './',
        'referrer-policy': 'no-referrer',
      },
    })
    expect(login.state.headers?.['set-cookie']).toMatch(/; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    expect(login.state.headers?.['set-cookie']).not.toContain('Secure')
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    expect(auth.isAuthenticated({
      headers: new Headers({ host: '127.0.0.1:3080', cookie: login.cookie }),
    })).toBe(true)
    expect(auth.isAuthenticated({ headers: new Headers() })).toBe(false)
    expect(auth.isAuthenticated(request('/', 'localhost:3080', { cookie: login.cookie }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3081', { cookie: login.cookie }))).toBe(false)
    expect(await auth.listSessions()).toHaveLength(1)
  })

  it('keeps one durable pairing code and its sessions across Host restarts', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const login = await exchange(auth)

    const reloaded = await createAuth(store)
    expect(reloaded.authenticatedUrl('http://127.0.0.1:3080')).toBe(login.pairingUrl)
    expect(reloaded.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)

    const restarted = await createAuth(store)
    expect(new URL(restarted.authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token'))
      .toBe(new URL(login.pairingUrl).searchParams.get('token'))
    expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)

    // A link whose code was superseded still resolves for an already paired
    // browser: the stale query is dropped and the existing cookie is kept.
    const reused = response()
    expect(await restarted.authorizeIndex(
      request('/?token=wrong', '127.0.0.1:3080', { cookie: login.cookie }), reused.value,
    )).toBe(false)
    expect(reused.state).toEqual({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': './',
        'referrer-policy': 'no-referrer',
      },
    })

    const fresh = response()
    const code = new URL(login.pairingUrl).searchParams.get('token') as string
    expect(await restarted.authorizeIndex(
      request(`/?token=${code}`, '127.0.0.1:3080'), fresh.value,
    )).toBe(false)
    expect(fresh.state.status).toBe(303)
  })

  it('gives every browser its own listed session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const auth = await createAuth(new RecordCredentials())
    const phone = await exchange(auth, '127.0.0.1:3080', false, { userAgent: 'Phone/1.0' })
    vi.setSystemTime(new Date('2026-08-24T00:05:00.000Z'))
    const laptop = await exchange(auth, '127.0.0.1:3080', false, { userAgent: 'Laptop/2.0' })

    const sessions = await auth.listSessions()
    const phonePaired = Date.parse('2026-08-24T00:00:00.000Z')
    const laptopPaired = Date.parse('2026-08-24T00:05:00.000Z')
    const dayMilliseconds = 24 * 60 * 60 * 1000
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toMatchObject({ userAgent: 'Phone/1.0', pairedAt: phonePaired, lastSeenAt: phonePaired, expiresAt: phonePaired + 30 * dayMilliseconds })
    expect(sessions[1]).toMatchObject({ userAgent: 'Laptop/2.0', pairedAt: laptopPaired, lastSeenAt: laptopPaired, expiresAt: laptopPaired + 30 * dayMilliseconds })
    expect(typeof sessions[0]!.id).toBe('string')
    expect(sessions[0]!.id).not.toBe(sessions[1]!.id)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: phone.cookie }))).toBe(true)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: laptop.cookie }))).toBe(true)
  })

  it('keeps one identity when the same browser pairs again, refreshing only its lifetime', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const auth = await createAuth(new RecordCredentials())
    const first = await exchange(auth, '127.0.0.1:3080', false, { userAgent: 'Phone/1.0' })
    const [firstSession] = await auth.listSessions()

    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'))
    const again = await exchange(auth, '127.0.0.1:3080', false, { cookie: first.cookie, userAgent: 'Phone/1.0' })
    const sessions = await auth.listSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe(firstSession!.id)
    expect(sessions[0]!.pairedAt).toBe(firstSession!.pairedAt)
    expect(sessions[0]!.expiresAt).toBeGreaterThan(firstSession!.expiresAt)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: again.cookie }))).toBe(true)
  })

  it('revokes one browser without disturbing the others or the pairing code', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const phone = await exchange(auth, '127.0.0.1:3080', false, { userAgent: 'Phone/1.0' })
    const laptop = await exchange(auth, '127.0.0.1:3080', false, { userAgent: 'Laptop/2.0' })
    const [, laptopSession] = await auth.listSessions()

    await auth.revokeSession((await auth.listSessions())[0]!.id)

    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: phone.cookie }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: laptop.cookie }))).toBe(true)
    const remaining = await auth.listSessions()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ id: laptopSession!.id, userAgent: laptopSession!.userAgent })

    // Revocation survives a restart, and the revoked browser cannot re-pair silently.
    const restarted = await createAuth(store)
    expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: phone.cookie }))).toBe(false)
    expect(restarted.authenticatedUrl('http://127.0.0.1:3080')).toBe(auth.authenticatedUrl('http://127.0.0.1:3080'))
    expect((await restarted.listSessions())[0]!.id).toBe(laptopSession!.id)
  })

  it('rotates the pairing code while already paired browsers stay signed in', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const phone = await exchange(auth, '127.0.0.1:3080', false, { userAgent: 'Phone/1.0' })
    const oldUrl = new URL(auth.authenticatedUrl('http://127.0.0.1:3080'))
    const oldCode = oldUrl.searchParams.get('token') as string

    await auth.rotatePairingCode()

    const rotatedUrl = new URL(auth.authenticatedUrl('http://127.0.0.1:3080'))
    expect(rotatedUrl.searchParams.get('token')).not.toBe(oldCode)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: phone.cookie }))).toBe(true)

    const denied = response()
    expect(await auth.authorizeIndex(request(`/?token=${oldCode}`, '127.0.0.1:3080'), denied.value)).toBe(false)
    expect(denied.state.status).toBe(401)

    const restarted = await createAuth(store)
    expect(new URL(restarted.authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token'))
      .toBe(rotatedUrl.searchParams.get('token'))
  })

  it('reports last-seen activity collected while answering requests and drops expired sessions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const auth = await createAuth(new RecordCredentials(), 1)
    const phone = await exchange(auth, '127.0.0.1:3080', false, { userAgent: 'Phone/1.0' })

    vi.setSystemTime(new Date('2026-08-24T06:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: phone.cookie }))).toBe(true)
    expect(await auth.listSessions()).toEqual([
      expect.objectContaining({ lastSeenAt: Date.parse('2026-08-24T06:00:00.000Z') }),
    ])

    vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: phone.cookie }))).toBe(false)
    expect(await auth.listSessions()).toEqual([])
  })

  it('upgrades a record that predates sessions, keeping its signing secret', async () => {
    const store = new RecordCredentials()
    const secret = Buffer.alloc(32, 7).toString('base64url')
    store.record = { kind: 'grant', payload: { version: 1, secret } }
    const auth = await createAuth(store)

    expect(await auth.listSessions()).toEqual([])
    expect(store.record).toMatchObject({
      kind: 'grant',
      payload: { version: 2, secret },
    })
    expect(auth.authenticatedUrl('http://127.0.0.1:3080')).toContain('token=')
  })

  it('keeps HTTPS port 443 distinct from HTTP port 80 with one signing secret', async () => {
    const auth = await createAuth(new RecordCredentials())
    const plain = await exchange(auth, 'harness.example')
    const tls = await exchange(auth, 'harness.example', true)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: plain.cookie }), true)).toBe(false)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: tls.cookie }), true)).toBe(true)
    expect(auth.isAuthenticated(request('/', 'harness.example:443', { cookie: tls.cookie }), true)).toBe(true)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: tls.cookie }))).toBe(false)
  })

  it('rejects HTTP cookie replay after enabling TLS on the same authority', async () => {
    const store = new RecordCredentials()
    const authority = 'harness.example:3080'
    const plain = await exchange(await createAuth(store), authority)
    const restarted = await createAuth(store)
    const denied = response()
    expect(await restarted.authorizeIndex(request('/', authority, { cookie: plain.cookie }), denied.value, true)).toBe(false)
    expect(denied.state.status).toBe(401)

    const tls = await exchange(restarted, authority, true)
    expect(tls.state.headers?.['set-cookie']).toContain('; Secure')
    expect(restarted.isAuthenticated(request('/', authority, { cookie: tls.cookie }), true)).toBe(true)
    expect(restarted.isAuthenticated(request('/', authority, { cookie: tls.cookie }))).toBe(false)
    const tlsName = tls.cookie.slice(0, tls.cookie.indexOf('='))
    const plainValue = plain.cookie.slice(plain.cookie.indexOf('=') + 1)
    expect(restarted.isAuthenticated(request('/', authority, { cookie: `${tlsName}=${plainValue}` }), true)).toBe(false)
  })

  it('preserves the caller authority and mount while adding only the pairing code', async () => {
    const auth = await createAuth(new RecordCredentials())
    const mounted = new URL(auth.authenticatedUrl('https://gateway.example/tools/dsh/'))
    expect(mounted.origin).toBe('https://gateway.example')
    expect(mounted.pathname).toBe('/tools/dsh/')
    expect([...mounted.searchParams.keys()]).toEqual(['token'])

    const loopback = new URL(auth.authenticatedUrl('http://127.0.0.1:3080/'))
    expect(loopback.origin).toBe('http://127.0.0.1:3080')
    expect(loopback.pathname).toBe('/')
    expect(loopback.searchParams.get('token')).toBe(mounted.searchParams.get('token'))

    // The proxy preserves the browser-facing Host and strips the mount.
    const code = mounted.searchParams.get('token')
    const exchanged = response()
    expect(await auth.authorizeIndex(request(`/?token=${String(code)}`, 'gateway.example'), exchanged.value)).toBe(false)
    const setCookie = exchanged.state.headers?.['set-cookie']
    if (setCookie === undefined) throw new Error('mount exchange did not set a cookie')
    expect(auth.isAuthenticated(request(
      '/', 'gateway.example', { cookie: setCookie.split(';', 1)[0]! },
    ))).toBe(true)
  })

  it('serves the index to a valid cookie and gives unauthenticated browsers the sign-in page', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { cookie } = await exchange(auth)
    const allowed = response()
    expect(await auth.authorizeIndex(request('/index.html', '127.0.0.1:3080', { cookie }), allowed.value)).toBe(true)
    expect(allowed.state).toEqual({})

    const pageHeaders = {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': LOGIN_CSP,
      'referrer-policy': 'no-referrer',
    }
    for (const candidate of [
      request('/'),
      request('/?token=wrong'),
      request('/?token=wrong&token=again'),
      request('/index.html?token=wrong'),
      request(auth.authenticatedUrl('http://127.0.0.1:3080'), '127.0.0.1:3080', { method: 'HEAD' }),
    ]) {
      const denied = response()
      expect(await auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
      expect(denied.state.headers).toEqual(pageHeaders)
      if (candidate.method === 'HEAD') expect(denied.state.body).toBeUndefined()
      else expect(denied.state.body).toContain('Open the app to sign in')
    }

    // A passcode form POST with no passcode configured still gets the plain 401 text.
    const posted = response()
    expect(await auth.authorizeIndex(submit({}), posted.value)).toBe(false)
    expect(posted.state).toEqual({
      status: 401,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      body: UNAUTHORIZED_BODY,
    })

    // A form POST that still carries a stale pairing token keeps the plain 401 text.
    const tokenPost = response()
    expect(await auth.authorizeIndex({ ...submit({}), url: '/?token=wrong' }, tokenPost.value)).toBe(false)
    expect(tokenPost.state).toEqual({
      status: 401,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      body: UNAUTHORIZED_BODY,
    })
  })

  it('rejects a tampered, truncated, or unsigned cookie', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = await exchange(auth)
    const [name, value] = cookie.split('=') as [string, string]

    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=broken` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=${value.slice(0, -1)}x` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=%` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie: signedBodyCookie(store, name, 'a'),
    }))).toBe(false)
    expect(auth.isAuthenticated({ headers: {} })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'bad host', cookie } })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: '127.0.0.1:3080' } })).toBe(false)

    const invalidPayloads: unknown[] = [
      'not json',
      null,
      { version: 2, authority: '127.0.0.1:3080', device: 'unknown-session', issuedAt: 1, expiresAt: 2 },
      { version: 2, authority: 42, device: 'AAAAAAAAAAAAAAAA' },
      { version: 1, authority: '127.0.0.1:3080' },
    ]
    for (const payload of invalidPayloads) {
      expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
        cookie: signedCookie(store, name, payload),
      }))).toBe(false)
    }
    const invalidDeviceBody = Buffer.from(JSON.stringify({
      version: 3,
      authority: '127.0.0.1:3080',
      device: 'unknown-session',
      issuedAt: 1,
      expiresAt: 2,
    }), 'utf8').toString('base64url')
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie: signedBodyCookie(store, name, invalidDeviceBody, 'v3'),
    }))).toBe(false)
  })

  it('stops verifying a session once its absolute lifetime has passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = await exchange(auth)

    // A shorter reactivation cannot extend a session minted under a longer lifetime.
    const shorter = await createAuth(store, 1)
    expect(shorter.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(true)

    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
  })

  it('loads one store per activation and replaces it after deletion on the next activation', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const first = await exchange(auth)
    expect(store).toMatchObject({ reads: 0, modifies: 2 })

    // A store that refuses the write leaves the pairing unadopted.
    store.discardWrites = true
    await expect(exchange(auth)).rejects.toThrow(/record is missing/u)
    store.discardWrites = false
    expect(store).toMatchObject({ reads: 0, modifies: 3 })

    await store.deleteRecord('client-connection/browser-session')
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(true)
    await expect(exchange(auth)).rejects.toThrow(/record is missing/u)
    expect(store).toMatchObject({ reads: 0, modifies: 4 })

    const reactivated = await createAuth(store)
    const second = await exchange(reactivated)
    expect(second.cookie).not.toBe(first.cookie)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(false)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: second.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 6 })
  })

  it('fails loud on an unreadable owner record instead of replacing it', async () => {
    const unsupported = new RecordCredentials()
    unsupported.record = { kind: 'api-key', key: 'not-a-cookie-secret' }
    await expect(createAuth(unsupported)).rejects.toThrow(/unsupported format/u)

    for (const secret of ['short', 42, null]) {
      const malformed = new RecordCredentials()
      malformed.record = { kind: 'grant', payload: { version: 1, secret } }
      await expect(createAuth(malformed)).rejects.toThrow(/unsupported format/u)
    }

    const badPairing = new RecordCredentials()
    badPairing.record = { kind: 'grant', payload: { version: 2, secret: Buffer.alloc(32, 1).toString('base64url'), pairing: 'short', sessions: [] } }
    await expect(createAuth(badPairing)).rejects.toThrow(/unsupported format/u)

    const notAnArray = new RecordCredentials()
    notAnArray.record = { kind: 'grant', payload: { version: 2, secret: Buffer.alloc(32, 1).toString('base64url'), pairing: Buffer.alloc(32, 2).toString('base64url'), sessions: {} } }
    await expect(createAuth(notAnArray)).rejects.toThrow(/unsupported format/u)

    const validSession = {
      id: Buffer.alloc(9, 3).toString('base64url'),
      userAgent: 'Phone/1.0',
      pairedAt: 1,
      lastSeenAt: 1,
      expiresAt: 2,
    }
    const badRows: unknown[] = [
      [null],
      [{ ...validSession, id: 42 }],
      [{ ...validSession, id: 'too-short' }],
      [{ ...validSession, userAgent: 42 }],
      [{ ...validSession, pairedAt: 'now' }],
      [{ ...validSession, lastSeenAt: 1.5 }],
      [{ ...validSession, expiresAt: 0 }],
      [validSession, validSession],
    ]
    for (const sessions of badRows) {
      const damaged = new RecordCredentials()
      damaged.record = {
        kind: 'grant',
        payload: {
          version: 2,
          secret: Buffer.alloc(32, 1).toString('base64url'),
          pairing: Buffer.alloc(32, 2).toString('base64url'),
          sessions,
        },
      }
      await expect(createAuth(damaged)).rejects.toThrow(/unsupported format/u)
    }

    const discarded = new RecordCredentials()
    discarded.discardWrites = true
    await expect(createAuth(discarded)).rejects.toThrow(/was not created/u)

    await expect(createAuth(new RecordCredentials(), Number.MAX_SAFE_INTEGER))
      .rejects.toThrow(/safe timestamp range/u)
  })

  it('records the browser User-Agent it paired, truncated for durable storage', async () => {
    const auth = await createAuth(new RecordCredentials())
    await exchange(auth, '127.0.0.1:3080', false, { userAgent: 'x'.repeat(400) })
    expect((await auth.listSessions())[0]!.userAgent).toHaveLength(256)

    const anonymous = await createAuth(new RecordCredentials())
    await exchange(anonymous)
    expect((await anonymous.listSessions())[0]!.userAgent).toBe('')
  })
})

describe('passcode login', () => {
  const AUTHORITY = '192.168.1.162:9445'

  it('serves the passcode page, the no-passcode sign-in page, and keeps a POST plain', async () => {
    const auth = await passcodeAuth(new RecordCredentials())
    const page = response()
    expect(await auth.authorizeIndex(request('/', AUTHORITY), page.value)).toBe(false)
    expect(page.state.status).toBe(401)
    expect(page.state.headers).toEqual({
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': LOGIN_CSP,
      'referrer-policy': 'no-referrer',
    })
    expect(page.state.body).toContain('<form method="post" action="./">')
    expect(page.state.body).toContain('id="passcode" name="passcode" type="password"')
    expect(page.state.body).not.toContain('class="error"')

    const head = response()
    expect(await auth.authorizeIndex(request('/', AUTHORITY, { method: 'HEAD' }), head.value)).toBe(false)
    expect(head.state.status).toBe(401)
    expect(head.state.body).toBeUndefined()
    expect(head.state.headers?.['content-type']).toBe('text/html; charset=utf-8')

    // Without an owner passcode a browser gets the sign-in page; a form POST gets plain text.
    for (const bare of [
      await BrowserAuth.create(credentials(new RecordCredentials()), 30),
      await createAuth(new RecordCredentials()),
    ]) {
      const signIn = response()
      expect(await bare.authorizeIndex(request('/', AUTHORITY), signIn.value)).toBe(false)
      expect(signIn.state.status).toBe(401)
      expect(signIn.state.headers).toEqual({
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': LOGIN_CSP,
        'referrer-policy': 'no-referrer',
      })
      expect(signIn.state.body).toContain('Open the app to sign in')
      expect(signIn.state.body).toContain('enable a passcode')
      expect(signIn.state.body).not.toContain('<form')

      const signInHead = response()
      expect(await bare.authorizeIndex(request('/', AUTHORITY, { method: 'HEAD' }), signInHead.value)).toBe(false)
      expect(signInHead.state.status).toBe(401)
      expect(signInHead.state.headers?.['content-type']).toBe('text/html; charset=utf-8')
      expect(signInHead.state.body).toBeUndefined()

      const posted = response()
      expect(await bare.authorizeIndex(submit({ authority: AUTHORITY }), posted.value)).toBe(false)
      expect(posted.state).toEqual({
        status: 401,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
        body: UNAUTHORIZED_BODY,
      })
    }
  })

  it('stores a salted one-way verifier, survives restart, and clears it', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    expect(await auth.passcodeSet()).toBe(false)
    await auth.setPasscode('correct-horse')
    expect(await auth.passcodeSet()).toBe(true)
    const stored = store.records.get('client-connection/passcode-verifier')
    expect(stored).toMatchObject({
      kind: 'grant',
      payload: { version: 1, algorithm: 'scrypt', n: 65_536, r: 8, p: 2, keyLength: 32 },
    })
    expect(JSON.stringify(stored)).not.toContain('correct-horse')
    const firstPayload = stored?.kind === 'grant' && typeof stored.payload === 'object' && stored.payload !== null
      ? stored.payload
      : undefined
    const firstSalt: unknown = firstPayload === undefined ? undefined : Reflect.get(firstPayload, 'salt')
    expect(typeof firstSalt).toBe('string')

    const restarted = await createAuth(store)
    const allowed = response()
    expect(await restarted.authorizeIndex(submit({
      authority: AUTHORITY, passcode: 'correct-horse',
    }), allowed.value)).toBe(false)
    expect(allowed.state.status).toBe(303)

    await auth.setPasscode('correct-horse')
    const replaced = store.records.get('client-connection/passcode-verifier')
    const replacedPayload = replaced?.kind === 'grant' && typeof replaced.payload === 'object' && replaced.payload !== null
      ? replaced.payload
      : undefined
    const replacedSalt: unknown = replacedPayload === undefined ? undefined : Reflect.get(replacedPayload, 'salt')
    expect(replacedSalt).not.toBe(firstSalt)

    await auth.clearPasscode()
    expect(await auth.passcodeSet()).toBe(false)
    expect(store.records.has('client-connection/passcode-verifier')).toBe(false)
  })

  it('accepts a maximum-length percent-encoded passcode', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const passcode = 'é'.repeat(1_024)
    await auth.setPasscode(passcode)
    const allowed = response()
    expect(await auth.authorizeIndex(submit({
      authority: AUTHORITY, passcode,
    }), allowed.value)).toBe(false)
    expect(allowed.state.status).toBe(303)
  })

  it('rejects passcodes outside the fixed bounds and refuses a malformed verifier', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    await expect(auth.setPasscode('short')).rejects.toThrow('passcode must be 12-1024 characters')
    await expect(auth.setPasscode('x'.repeat(1_025))).rejects.toThrow('passcode must be 12-1024 characters')

    const malformed = [
      { kind: 'api-key', payload: undefined },
      { kind: 'grant', payload: 'not-an-object' },
      { kind: 'grant', payload: { version: 2, algorithm: 'scrypt', salt: 'bad', hash: 'bad', n: 65_536, r: 8, p: 2, keyLength: 32 } },
      { kind: 'grant', payload: { version: 1, algorithm: 'scrypt', salt: 'bad', hash: 'bad', n: 65_536, r: 8, p: 2, keyLength: 32 } },
    ] as const
    for (const record of malformed) {
      store.records.set('client-connection/passcode-verifier', record)
      await expect(auth.passcodeSet()).rejects.toThrow('passcode verifier credential record is malformed')
    }

    store.discardWrites = true
    await expect(auth.setPasscode('correct-horse')).rejects.toThrow('passcode verifier credential record was not created')
  })

  it('surfaces a key-derivation failure without writing a verifier', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    scryptMock.mockImplementationOnce((_password, _salt, _keyLength, _options, callback) => {
      callback(new Error('kdf failed'), Buffer.alloc(0))
    })
    await expect(auth.setPasscode('correct-horse')).rejects.toThrow('kdf failed')
    expect(store.records.has('client-connection/passcode-verifier')).toBe(false)
  })

  it('pairs a browser on the matching passcode and rejects malformed submissions', async () => {
    const store = new RecordCredentials()
    const auth = await passcodeAuth(store)

    const submissions = [
      [{ passcode: 'wrong' }, 401, 'Incorrect passcode. Try again.'],
      [{ body: 'passcode=' }, 401, 'Incorrect passcode. Try again.'],
      [{ body: 'other=value' }, 400, 'The passcode form was not submitted correctly.'],
      [{ contentType: 'text/plain' }, 400, 'The passcode form was not submitted correctly.'],
      [{ body: `passcode=${'a'.repeat(20_000)}` }, 400, 'The passcode form was not submitted correctly.'],
    ] as const
    for (const [body, status, error] of submissions) {
      const denied = response()
      expect(await auth.authorizeIndex(submit({
        authority: AUTHORITY, remoteAddress: '10.0.0.1', ...body,
      }), denied.value)).toBe(false)
      expect(denied.state.status).toBe(status)
      expect(denied.state.body).toContain(error)
    }

    const head = response()
    expect(await auth.authorizeIndex(request('/', AUTHORITY, { method: 'HEAD' }), head.value)).toBe(false)
    expect(head.state.status).toBe(401)
    expect(head.state.body).toBeUndefined()
    expect(head.state.headers?.['content-security-policy']).toBe(LOGIN_CSP)

    // Neither a socket address nor an authority leaves only the fallback key.
    const unaddressed = response()
    expect(await auth.authorizeIndex(submit({ body: 'passcode=wrong' }), unaddressed.value)).toBe(false)
    expect(unaddressed.state.status).toBe(400)
    expect(unaddressed.state.body).toContain('The passcode form was not submitted correctly.')

    // Without a socket address the authority keys the attempt table.
    const noPeer = response()
    expect(await auth.authorizeIndex(submit({
      authority: AUTHORITY, passcode: 'wrong',
    }), noPeer.value)).toBe(false)
    expect(noPeer.state.status).toBe(401)

    const allowed = response()
    expect(await auth.authorizeIndex(submit({
      authority: AUTHORITY, remoteAddress: '10.0.0.1', passcode: 'correct-horse',
    }), allowed.value)).toBe(false)
    expect(allowed.state).toMatchObject({ status: 303, headers: { location: './' } })
    const cookie = allowed.state.headers?.['set-cookie']?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('passcode pairing did not set a cookie')
    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie }))).toBe(true)
    expect(await auth.listSessions()).toHaveLength(1)
  })

  it('blocks repeated failures per peer, reports the remaining wait, and resets on success', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const auth = await passcodeAuth(new RecordCredentials())
    const blocked = '10.0.0.1'
    const other = '10.0.0.2'

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const denied = response()
      expect(await auth.authorizeIndex(submit({
        authority: AUTHORITY, remoteAddress: blocked, passcode: 'wrong',
      }), denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
      expect(denied.state.body).toContain('Incorrect passcode. Try again.')
    }
    const limited = response()
    expect(await auth.authorizeIndex(submit({
      authority: AUTHORITY, remoteAddress: blocked, passcode: 'correct-horse',
    }), limited.value)).toBe(false)
    expect(limited.state.status).toBe(429)
    expect(limited.state.headers?.['retry-after']).toBe('60')
    expect(limited.state.body).toContain('Too many attempts. Try again in a minute.')

    const otherPeer = response()
    expect(await auth.authorizeIndex(submit({
      authority: AUTHORITY, remoteAddress: other, passcode: 'wrong',
    }), otherPeer.value)).toBe(false)
    expect(otherPeer.state.status).toBe(401)

    vi.setSystemTime(new Date('2026-08-24T00:01:00.000Z'))
    // Recording this peer's failure also drops the expired entry for `blocked`.
    const again = response()
    expect(await auth.authorizeIndex(submit({
      authority: AUTHORITY, remoteAddress: other, passcode: 'wrong',
    }), again.value)).toBe(false)
    expect(again.state.status).toBe(401)

    const recovered = response()
    expect(await auth.authorizeIndex(submit({
      authority: AUTHORITY, remoteAddress: blocked, passcode: 'correct-horse',
    }), recovered.value)).toBe(false)
    expect(recovered.state.status).toBe(303)

    const afterSuccess = response()
    expect(await auth.authorizeIndex(submit({
      authority: AUTHORITY, remoteAddress: blocked, passcode: 'wrong',
    }), afterSuccess.value)).toBe(false)
    expect(afterSuccess.state.status).toBe(401)

    // A peer that waits out its own block is admitted again: reading its entry
    // drops the expired block instead of reporting it.
    const waiting = '10.0.0.3'
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const denied = response()
      expect(await auth.authorizeIndex(submit({
        authority: AUTHORITY, remoteAddress: waiting, passcode: 'wrong',
      }), denied.value)).toBe(false)
    }
    vi.setSystemTime(new Date('2026-08-24T00:02:00.000Z'))
    const waited = response()
    expect(await auth.authorizeIndex(submit({
      authority: AUTHORITY, remoteAddress: waiting, passcode: 'correct-horse',
    }), waited.value)).toBe(false)
    expect(waited.state.status).toBe(303)
  }, 30_000)

  it('keeps a signed-in browser on the application without consulting the passcode', async () => {
    const auth = await passcodeAuth(new RecordCredentials())
    const login = await exchange(auth)
    const allowed = response()
    expect(await auth.authorizeIndex(request('/', '127.0.0.1:3080', { cookie: login.cookie }), allowed.value)).toBe(true)
    expect(allowed.state).toEqual({})
  })
})
