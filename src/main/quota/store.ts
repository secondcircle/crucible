import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import type { QuotaError, QuotaSnapshot } from '../../shared/quota/types'
import { ADAPTERS } from './adapters/index'
import type { FetchLike, ProviderAdapter } from './adapters/types'
import { CACHE_SCHEMA_VERSION, cacheFile, lockFile, quotaCacheDir } from './paths'
import { cachedProviderIds, type CacheEntry, readEntry, readQuota } from './reader'

// Every provider gets its own file, its own lock and its own pass, so one
// provider's outage cannot deny the others. There is deliberately no timer
// here: the TTL suppresses fetches and never starts one.

/** Serve the cache rather than fetch while an attempt is younger than this. */
export const DEFAULT_TTL_MS = 60_000
/** Node `fetch` has no default timeout, so a signal is always passed. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000
/** A lock older than this is stolen: the only recovery from a process that died holding one. */
export const LOCK_STALE_MS = 30_000

const LOCK_POLL_MS = 25

/** The slice of π's `AuthResult` this module uses. Nothing else is touched. */
export interface AuthLike {
  readonly auth: { readonly apiKey?: string; readonly headers?: Record<string, unknown> }
}

export interface QuotaStoreOptions {
  /** `undefined` means logged out: that provider's cache file is deleted. */
  readonly getAuth: (providerId: string) => Promise<AuthLike | undefined>
  readonly adapters?: readonly ProviderAdapter[]
  readonly ttlMs?: number
  readonly fetchTimeoutMs?: number
  readonly now?: () => number
  /**
   * An `api_key` account has no subscription meters, so it is absent rather
   * than a row showing `—`. `undefined` means no gate.
   */
  readonly credentialType?: (providerId: string) => 'oauth' | 'api_key' | undefined
  /** Overrides the cache location, which is how a test stays off the real one. */
  readonly dir?: string
  readonly fetchImpl?: FetchLike
  readonly log?: (message: string) => void
}

export interface RefreshOptions {
  /** For a consumer that needs guaranteed freshness and pays for it. */
  readonly force?: boolean
  /**
   * Refresh only these providers, so no other provider's quota is spent on a
   * window that did not turn over.
   */
  readonly providers?: readonly string[]
}

export interface QuotaStore {
  /** One attempt per provider in scope, TTL-gated. Never throws; never retries. */
  refresh(opts?: RefreshOptions): Promise<QuotaSnapshot>
  read(): QuotaSnapshot
}

// Absence is a decision about the account rather than about one store's
// memory, so two stores in one process cannot undo each other's. The stamp is
// a ticket rather than a time because stores may carry different clocks and
// only "which happened first" is being asked.
const absenceTickets = new Map<string, number>()
let ticketCounter = 0
const nextTicket = (): number => (ticketCounter += 1)

/** `undefined` in, `undefined` out: "cannot tell" stays distinct from "no". */
export function credentialTypeFrom(isOAuth: boolean | undefined): 'oauth' | 'api_key' | undefined {
  if (isOAuth === undefined) return undefined
  return isOAuth ? 'oauth' : 'api_key'
}

// π expresses the bearer either way; neither form is a refresh token.
function bearerFrom(auth: AuthLike): string | undefined {
  if (auth.auth.apiKey) return auth.auth.apiKey
  const headers = auth.auth.headers ?? {}
  const authorization = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authorization'
  )?.[1]
  if (typeof authorization !== 'string') return undefined
  return /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] ?? authorization
}

export function createQuotaStore(options: QuotaStoreOptions): QuotaStore {
  const adapters = options.adapters ?? ADAPTERS
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS

  const now = options.now ?? Date.now
  const dir = options.dir
  // Not warn-once: this sink speaks only on a state transition, and a provider
  // that goes down, recovers and goes down again must say so all three times.
  const log = options.log ?? ((message: string) => console.warn(`[quota:store] ${message}`))
  const adapterLog = options.log

  /** Last logged state per provider, so a transition logs once and an outage does not. */
  const lastState = new Map<string, QuotaError | 'ok'>()

  // A process restarted while a provider was down has an empty memory but not
  // an empty cache, and the recovery that follows is still a real transition.
  function persistedState(providerId: string): QuotaError | 'ok' | undefined {
    const entry = readEntry(providerId, dir)
    if (entry === null) return undefined
    return entry.error ?? 'ok'
  }

  // `force` rides along because a pass that may honor the TTL cannot stand in
  // for one that was promised guaranteed freshness.
  const inflight = new Map<string, { promise: Promise<void>; force: boolean }>()

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // Only on a change of state: an hour-long outage must not fill the log, and
  // a recovery must still be heard.
  function noteState(providerId: string, state: QuotaError | 'ok', detail?: string): void {
    // Memory first, then the cache: the state survives a process restart
    // because the cache is what survives a process restart.
    const previous = lastState.get(providerId) ?? persistedState(providerId)
    lastState.set(providerId, state)
    if (previous === state) return
    if (state === 'ok') {
      // A first-ever success is not a recovery; there was nothing to recover from.
      if (previous !== undefined) log(`${providerId}: quota fetch recovered`)
      return
    }
    log(`${providerId}: quota fetch failed (${state})${detail === undefined ? '' : ` — ${detail}`}`)
  }

  // `writeFileSync`'s `mode` applies only when it creates the file, so a temp
  // file left by a crash would be renamed into place carrying old permissions.
  function publish(file: string, contents: string): void {
    const tmp = `${file}.${process.pid}.tmp`
    mkdirSync(quotaCacheDir(dir), { recursive: true, mode: 0o700 })
    rmSync(tmp, { force: true })
    writeFileSync(tmp, contents, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file) // atomic: a reader never sees a partial file
  }

  // A fresh write id per write, so a pass that read the file earlier can tell
  // a write happened even when two writes claim the same instant.
  function writeEntry(entry: CacheEntry): void {
    const stamped: CacheEntry = { ...entry, writeId: randomUUID() }
    publish(cacheFile(entry.providerId, dir), JSON.stringify(stamped))
  }

  // Deletion claims the lock rather than waiting for it: a fetch in flight
  // elsewhere must not publish afterwards and resurrect the provider.
  function deleteEntry(providerId: string): void {
    // Stamp the decision for other stores in this process…
    absenceTickets.set(cacheFile(providerId, dir), nextTicket())
    const token = claimLock(providerId)
    try {
      rmSync(cacheFile(providerId, dir), { force: true })
      // …and, by removing their announcements, reach passes already under way
      // in this process or any other.
      cancelPasses(providerId)
    } catch {
      // Nothing to clean up, or someone else already did.
    } finally {
      unlock(providerId, token)
    }
  }

  // ---------------------------------------------------------------- presence
  //
  // A pass announces itself in a file before resolving credentials so that a
  // logout anywhere can cancel it: finding its own announcement gone, it
  // abandons rather than spend a bearer belonging to an account that has left.

  let passSeq = 0

  function passFile(providerId: string): string {
    passSeq += 1
    return `${cacheFile(providerId, dir)}.${process.pid}.${passSeq}.pass`
  }

  const PASS_SUFFIX = '.pass'

  function passFilesFor(providerId: string): string[] {
    const prefix = `${providerId}.json.`
    try {
      return readdirSync(quotaCacheDir(dir))
        .filter((name) => name.startsWith(prefix) && name.endsWith(PASS_SUFFIX))
        .map((name) => join(quotaCacheDir(dir), name))
    } catch {
      return []
    }
  }

  /** Returns the file to watch, or null if it cannot be written. */
  function announcePass(providerId: string): string | null {
    const file = passFile(providerId)
    try {
      mkdirSync(quotaCacheDir(dir), { recursive: true, mode: 0o700 })
      writeFileSync(file, JSON.stringify({ at: Date.now() }), { flag: 'wx', mode: 0o600 })
      return file
    } catch {
      return null
    }
  }

  // Reaches passes in other processes too, which is why it is a file at all.
  function cancelPasses(providerId: string): void {
    for (const file of passFilesFor(providerId)) {
      try {
        rmSync(file, { force: true })
      } catch {
        // Its owner got there first; either way that pass is done.
      }
    }
  }

  // Parsed off the known prefix rather than by splitting, because a provider
  // id may itself contain dots.
  function passOwnerPid(providerId: string, file: string): number | null {
    const name = basename(file)
    const inner = name.slice(`${providerId}.json.`.length, -PASS_SUFFIX.length)
    const pid = Number.parseInt(inner.split('.')[0] ?? '', 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }

  /** Signal 0 asks whether a process is alive without delivering anything. */
  function processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM: it exists, it simply is not ours to signal. ESRCH: it is gone.
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  // Old and dead, never merely old: nothing bounds a credential lookup, so a
  // slow one is not a corpse and cancelling it would cost a provider its
  // meters. A reused pid can leave a stray file instead, which is cheaper.
  function sweepPasses(providerId: string): void {
    for (const file of passFilesFor(providerId)) {
      try {
        if (Date.now() - statSync(file).mtimeMs <= LOCK_STALE_MS) continue
        const pid = passOwnerPid(providerId, file)
        // An unparseable name is not something any pass here is watching.
        if (pid !== null && processAlive(pid)) continue
        rmSync(file, { force: true })
      } catch {
        // Gone already.
      }
    }
  }

  // Only deletion takes a held lock, because its result supersedes whatever
  // the holder is doing: that holder is fetching for an account that is gone.
  function claimLock(providerId: string): string {
    const taken = tryLock(providerId)
    if (taken !== null) return taken
    const token = `${process.pid}:${randomUUID()}`
    try {
      mkdirSync(quotaCacheDir(dir), { recursive: true, mode: 0o700 })
      writeFileSync(lockFile(providerId, dir), JSON.stringify({ token, at: now() }), {
        mode: 0o600
      })
    } catch {
      // Unwritable lock: the delete below still runs, and the holder's write
      // may survive it. One TTL later the next pass settles the truth.
    }
    return token
  }

  // A fetch whose lock was taken has been superseded, and publishing its
  // result would undo whoever took over.
  function stillHolds(providerId: string, token: string): boolean {
    try {
      const held: unknown = JSON.parse(readFileSync(lockFile(providerId, dir), 'utf8'))
      return (
        held !== null &&
        typeof held === 'object' &&
        (held as { token?: unknown }).token === token
      )
    } catch {
      return false
    }
  }

  /** Acquire this provider's lock. Returns our token, or null if someone holds it. */
  function tryLock(providerId: string): string | null {
    const file = lockFile(providerId, dir)
    const token = `${process.pid}:${randomUUID()}`
    // The acquisition instant lives *in* the file rather than in its mtime, so
    // the store's clock governs staleness as it governs everything else.
    const held = JSON.stringify({ token, at: now() })
    try {
      mkdirSync(quotaCacheDir(dir), { recursive: true, mode: 0o700 })
      writeFileSync(file, held, { flag: 'wx', mode: 0o600 })
      return token
    } catch {
      try {
        // Stealing a lock older than the stale window is the only recovery
        // from a process that died holding one.
        if (lockAge(file) > LOCK_STALE_MS) {
          unlinkSync(file)
          writeFileSync(file, held, { flag: 'wx', mode: 0o600 })
          return token
        }
      } catch {
        // Lost the race to steal it. The winner's result serves us too.
      }
      return null
    }
  }

  // Capped at the fetch timeout: a holder cannot legitimately take longer, and
  // past the steal window the lock is takeable anyway.
  async function waitForLock(providerId: string): Promise<void> {
    const file = lockFile(providerId, dir)
    // Real time, not the injected clock: this waits on another process's work,
    // which no test clock governs.
    const until = Date.now() + Math.min(fetchTimeoutMs, LOCK_STALE_MS)
    while (Date.now() < until) {
      await sleep(LOCK_POLL_MS)
      if (!existsSync(file)) return // released: the winner's write has landed
    }
  }

  function lockAge(file: string): number {
    try {
      const held: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (
        held !== null &&
        typeof held === 'object' &&
        typeof (held as { at?: unknown }).at === 'number'
      ) {
        return now() - (held as { at: number }).at
      }
    } catch {
      // Unreadable, or written by something that is not this module.
    }
    return Date.now() - statSync(file).mtimeMs
  }

  // Only our own: a fetch declared stale and taken over must never unlock its
  // successor.
  function unlock(providerId: string, token: string): void {
    const file = lockFile(providerId, dir)
    try {
      const held: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (
        held === null ||
        typeof held !== 'object' ||
        (held as { token?: unknown }).token !== token
      ) {
        return
      }
      unlinkSync(file)
    } catch {
      // Already stolen or already gone.
    }
  }

  // Only the attempt's age moves, never the data's, so a row can dim a reading
  // and show how old it is while the TTL still holds off a retry storm. The
  // caller must hold the lock: a lockless write can undo a winner's success.
  function noteFailedAttempt(providerId: string, error: QuotaError): void {
    const cached = readEntry(providerId, dir)
    const at = now()
    writeEntry({
      v: CACHE_SCHEMA_VERSION,
      providerId,
      windows: cached?.windows ?? [],
      fetchedAt: cached?.fetchedAt ?? at,
      attemptedAt: at,
      error
    })
  }

  // Defers to a healthy reading younger than the TTL: some process with a
  // working credential proved the provider fine seconds ago, and dimming that
  // would report our own problem as their outage.
  function noteCredentialFailure(pass: Pass, detail: string): void {
    const { providerId } = pass
    const token = tryLock(providerId)
    // Held: someone is mid-fetch with a credential of their own. Their result
    // supersedes our inability to get one.
    if (token === null) return
    try {
      if (supersededDuringPass(pass)) return
      const cached = readEntry(providerId, dir)
      if (cached !== null && cached.error === undefined && now() - cached.attemptedAt < ttlMs) {
        return
      }
      noteState(providerId, 'unavailable', detail)
      noteFailedAttempt(providerId, 'unavailable')
    } finally {
      unlock(providerId, token)
    }
  }

  // A cache file no registered adapter owns is residue, not data, and absence
  // cannot depend on the directory never having held that provider. So a store
  // owns the directory it is pointed at, and a caller with a partial adapter
  // set should point it somewhere of its own.
  function pruneCache(): void {
    const registered = new Set(adapters.map((adapter) => adapter.providerId))
    for (const providerId of cachedProviderIds(dir)) {
      if (registered.has(providerId)) continue
      try {
        rmSync(cacheFile(providerId, dir), { force: true })
      } catch {
        // Someone else got there first.
      }
      absenceTickets.set(cacheFile(providerId, dir), nextTicket())
      cancelPasses(providerId)
    }
    // Every registered provider, not only those with a cache file: an orphaned
    // announcement outlives the reading it was made for.
    for (const adapter of adapters) sweepPasses(adapter.providerId)
  }

  // What a pass remembers about when it began, so it can tell whether it still
  // counts.
  interface Pass {
    readonly providerId: string
    readonly startedTicket: number
    /** Null if unwritable. */
    readonly presence: string | null
    readonly before: number | null
    /** Recognizes somebody else's publication without asking either clock. */
    readonly beforeWriteId: string | undefined
  }

  // Every branch here means "do not fetch, do not write": spending the bearer
  // would be a wasted request, a resurrection, or an overwrite of a fresher
  // reading with no new information.
  function supersededDuringPass(pass: Pass): boolean {
    const { providerId, startedTicket, presence, before, beforeWriteId } = pass
    const absentTicket = absenceTickets.get(cacheFile(providerId, dir))
    // This process's own record is an exact order, so it needs no clock.
    if (absentTicket !== undefined && absentTicket > startedTicket) return true
    // Our announcement is gone: somebody decided this provider must be absent
    // while we were away resolving credentials.
    if (presence !== null && !existsSync(presence)) return true

    const entry = readEntry(providerId, dir)
    if (before !== null && entry === null) return true
    if (entry === null) return false
    const republished =
      entry.writeId !== undefined || beforeWriteId !== undefined
        ? entry.writeId !== beforeWriteId
        : entry.attemptedAt !== before
    return republished && now() - entry.attemptedAt < ttlMs
  }

  async function refreshProvider(adapter: ProviderAdapter, force: boolean): Promise<void> {
    const providerId = adapter.providerId

    // Before the credential seam: `getAuth` may refresh a token over the
    // network, so asking it about a fresh cache would put traffic behind the
    // gate whose job is to prevent traffic. A logout lands within one TTL.
    const cached = readEntry(providerId, dir)
    if (!force && cached !== null && now() - cached.attemptedAt < ttlMs) return

    const pass: Pass = {
      providerId,
      startedTicket: nextTicket(),
      presence: announcePass(providerId),
      before: cached?.attemptedAt ?? null,
      beforeWriteId: cached?.writeId
    }
    try {
      await runPass(adapter, pass)
    } finally {
      if (pass.presence !== null) rmSync(pass.presence, { force: true })
    }
  }

  async function runPass(adapter: ProviderAdapter, pass: Pass): Promise<void> {
    const providerId = adapter.providerId

    let auth: AuthLike | undefined
    try {
      auth = await options.getAuth(providerId)
    } catch (error) {
      // A lookup that threw is not a logout: π rotates tokens under a lock, so
      // a transient failure is expected and deleting the cache would make a
      // logged-in provider vanish.
      noteCredentialFailure(
        pass,
        `credential lookup failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }
    // Only an actual `undefined` is a logout, and it is cleaned up here
    // because the reader never consults credentials.
    if (auth === undefined) return deleteEntry(providerId)
    if (options.credentialType?.(providerId) === 'api_key') return deleteEntry(providerId)
    const bearer = bearerFrom(auth)
    if (bearer === undefined) return deleteEntry(providerId)

    let token = tryLock(providerId)
    if (token === null) {
      // Wait rather than serve a cache we know is about to be replaced: the
      // loser is contracted to serve the winner's fresh reading.
      await waitForLock(providerId)
      if (supersededDuringPass(pass)) return // the winner served us
      token = tryLock(providerId)
      // Still held: serve what is on disk, and the next trigger is the retry.
      if (token === null) return
    }

    // Holding the lock is not being current: the meantime inside `getAuth` is
    // long enough for a winner to publish or a logout to land, and one file
    // read is cheaper than a redundant authenticated GET.
    if (supersededDuringPass(pass)) {
      unlock(providerId, token)
      return
    }

    try {
      const result = await adapter.fetchQuota(bearer, {
        // Wall clock even when a clock is injected: this bounds a socket, and
        // the signal that cancels one measures real time and nothing else.
        deadline: Date.now() + fetchTimeoutMs,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(adapterLog === undefined ? {} : { log: adapterLog })
      })
      // The lock can be taken away mid-request, by a logout or by the steal
      // this fetch invited by outrunning its own timeout. Publishing then would
      // undo whoever took over.
      if (!stillHolds(providerId, token)) return
      if (result.ok) {
        const at = now()
        noteState(providerId, 'ok')
        writeEntry({
          v: CACHE_SCHEMA_VERSION,
          providerId,
          windows: result.meters,
          fetchedAt: at,
          attemptedAt: at
        })
        return
      }
      noteState(providerId, result.error)
      // Keep the last good meters: the row dims them and shows their age.
      noteFailedAttempt(providerId, result.error)
    } catch (error) {
      // An adapter that throws is a bug, not a state, and must still not deny
      // the other providers or leave a lock behind.
      if (!stillHolds(providerId, token)) return
      noteState(
        providerId,
        'unavailable',
        `adapter threw: ${error instanceof Error ? error.message : String(error)}`
      )
      noteFailedAttempt(providerId, 'unavailable')
    } finally {
      unlock(providerId, token)
    }
  }

  function read(): QuotaSnapshot {
    return readQuota({ ...(dir === undefined ? {} : { dir }), now })
  }

  // A `force` request is queued behind an ordinary pass rather than folded
  // into it: that pass may be a TTL hit that fetches nothing.
  function passFor(adapter: ProviderAdapter, force: boolean): Promise<void> {
    const providerId = adapter.providerId
    const existing = inflight.get(providerId)
    if (existing !== undefined && (!force || existing.force)) return existing.promise

    const entry: { promise: Promise<void>; force: boolean } = {
      promise: Promise.resolve(),
      force
    }
    entry.promise = (existing?.promise ?? Promise.resolve())
      .then(() => refreshProvider(adapter, force))
      // One provider's failure cannot deny the others.
      .catch((error: unknown) => {
        log(
          `${providerId}: refresh pass failed — ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        if (inflight.get(providerId) === entry) inflight.delete(providerId)
      })
    inflight.set(providerId, entry)
    return entry.promise
  }

  return {
    read,
    refresh(opts: RefreshOptions = {}): Promise<QuotaSnapshot> {
      // Whatever the scope: absence must not depend on which providers this
      // particular trigger asked about.
      pruneCache()
      const wanted = opts.providers
      const scope =
        wanted === undefined
          ? adapters
          : adapters.filter((adapter) => wanted.includes(adapter.providerId))
      return Promise.all(scope.map((adapter) => passFor(adapter, opts.force === true))).then(read)
    }
  }
}
