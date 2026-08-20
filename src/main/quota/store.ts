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

/**
 * The fetching, caching, locking half of the quota plumbing.
 *
 * Ask it to refresh; it serves the cache if fresh, else takes a per-provider
 * cross-process lock, fetches, writes each result atomically, releases. Two
 * processes never double-fetch, and one provider's outage cannot deny the
 * others — every provider is its own file, its own lock and its own pass.
 *
 * Credentials arrive as an injected `getAuth` and are never re-derived: main
 * passes π's registry call. π rotates tokens under a file lock, so a second
 * reader of `auth.json` eventually holds a dead bearer — this module never
 * reads it.
 *
 * What is hidden behind this interface: locks, stealing, atomic replace,
 * timeouts, the TTL. What is deliberately *not* here: any timer. A TTL only
 * suppresses fetches; it never starts one.
 */

/** Serve the cache rather than fetch while an attempt is younger than this. */
export const DEFAULT_TTL_MS = 60_000
/** Node `fetch` has NO default timeout — always pass a signal. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000
/** A lock older than this is stolen: the only recovery from a process that died holding one. */
export const LOCK_STALE_MS = 30_000

/** How often a store that lost the lock looks to see whether the winner is done. */
const LOCK_POLL_MS = 25

/** The slice of π's `AuthResult` this module uses. Nothing else is touched. */
export interface AuthLike {
  readonly auth: { readonly apiKey?: string; readonly headers?: Record<string, unknown> }
}

export interface QuotaStoreOptions {
  /** π's own credential path. `undefined` = logged out: the file is deleted. */
  readonly getAuth: (providerId: string) => Promise<AuthLike | undefined>
  /** Default: the registered, verified three. */
  readonly adapters?: readonly ProviderAdapter[]
  /** Default 60_000. */
  readonly ttlMs?: number
  /** Default 10_000. */
  readonly fetchTimeoutMs?: number
  /** Injected clock for tests. */
  readonly now?: () => number
  /**
   * The stored credential's type, when the host can tell — π's auth check knows
   * it, a bare bearer does not. An `api_key` account has no subscription
   * meters, so it is absent rather than a row showing `—`. An absent hook, or
   * `undefined` for a provider, means no gate.
   */
  readonly credentialType?: (providerId: string) => 'oauth' | 'api_key' | undefined
  /** Cache directory override — the fixture seam the tests use. */
  readonly dir?: string
  /** Transport handed to every adapter; defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike
  /**
   * Diagnostics sink. Defaults to a plain `console.warn` for the store's own
   * messages, which are already emitted once per provider per state transition;
   * adapters keep their warn-once sink unless this is set, in which case it
   * receives both.
   */
  readonly log?: (message: string) => void
}

export interface RefreshOptions {
  /** Ignore the TTL. For a consumer that needs guaranteed freshness. */
  readonly force?: boolean
  /**
   * Refresh only these providers. The strip uses it when one provider's
   * countdown reaches zero: that provider is refreshed, and nobody else's quota
   * is spent on an authenticated GET for a window that did not turn over.
   */
  readonly providers?: readonly string[]
}

export interface QuotaStore {
  /** One attempt per provider in scope, TTL-gated. Never throws; never retries. */
  refresh(opts?: RefreshOptions): Promise<QuotaSnapshot>
  /** The cache, right now. Identical to `readQuota()` on the same directory. */
  read(): QuotaSnapshot
}

/**
 * Absence decisions, process-wide, keyed by the cache file they concern.
 *
 * When any store decides a provider must be absent — logged out, an API-key
 * account, a credential that yields no bearer, a file no adapter owns — it
 * stamps that decision here. A refresh that began earlier, and is still
 * resolving credentials with a bearer for the account that just became
 * ineligible, checks this before it spends that bearer: absence is a decision
 * about the account, not about one store instance's memory, and two stores in
 * one process (a service and a test's subject) must not be able to undo each
 * other's.
 *
 * The stamp is a ticket from a shared counter, not a time: stores may carry
 * different injected clocks, and "which happened first" is the only question
 * being asked. Keyed by the resolved cache path, so directories never collide.
 */
const absenceTickets = new Map<string, number>()
let ticketCounter = 0
const nextTicket = (): number => (ticketCounter += 1)

/**
 * The credential-type gate, from whatever the host can tell us about OAuth.
 *
 * An API-key account has no subscription meters, so it must be *absent* rather
 * than fetched for and rendered as a dash, and "the host does not know" must
 * stay distinct from "the host says no". `undefined` in, `undefined` out — no
 * gate.
 */
export function credentialTypeFrom(isOAuth: boolean | undefined): 'oauth' | 'api_key' | undefined {
  if (isOAuth === undefined) return undefined
  return isOAuth ? 'oauth' : 'api_key'
}

/** The bearer π resolved, however it chose to express it. Never a refresh token. */
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
  // The store's own sink is NOT warn-once: it already speaks only on a state
  // transition, and a provider that goes down, recovers and goes down again
  // must say so all three times — text-keyed suppression would swallow the
  // third. Adapters keep their warn-once default (an unfamiliar meter logs once
  // per process, not once per attempt) unless the caller injects a sink.
  const log = options.log ?? ((message: string) => console.warn(`[quota:store] ${message}`))
  const adapterLog = options.log

  /** Last logged state per provider, so a transition logs once and an outage does not. */
  const lastState = new Map<string, QuotaError | 'ok'>()

  /**
   * What the last process to touch this provider ended up saying, recovered
   * from the cache file. A process restarted while a provider was down has an
   * empty memory but not an empty cache, and the recovery that follows is a
   * real transition that must still be reported once.
   */
  function persistedState(providerId: string): QuotaError | 'ok' | undefined {
    const entry = readEntry(providerId, dir)
    if (entry === null) return undefined
    return entry.error ?? 'ok'
  }

  /**
   * In-process dedupe, per provider: overlapping triggers share one pass for
   * the provider they overlap on, and a scoped refresh never stands in for a
   * wider one. The `force` flag rides along because a pass that may honor the
   * TTL cannot stand in for one that was promised guaranteed freshness.
   */
  const inflight = new Map<string, { promise: Promise<void>; force: boolean }>()

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Say something only when this provider's state actually changed. A provider
   * that has been down for an hour must not fill the log, one that recovers
   * must say so, and one that goes down again after recovering must say so
   * again — which is why the sink behind this is not warn-once.
   */
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

  /**
   * Publish a file atomically, at 0600 whatever was there before.
   *
   * `writeFileSync`'s `mode` only applies when it *creates* the file: a
   * `*.pid.tmp` left by a crash (same pid, later run) would be opened,
   * truncated, and renamed into place carrying its old permissions. Removing it
   * first and setting the mode explicitly means the published cache satisfies
   * the file-mode contract no matter what it inherited.
   */
  function publish(file: string, contents: string): void {
    const tmp = `${file}.${process.pid}.tmp`
    // 0700/0600 matches the agent dir's posture, even though these files hold
    // percentages and reset instants and nothing else.
    mkdirSync(quotaCacheDir(dir), { recursive: true, mode: 0o700 })
    rmSync(tmp, { force: true })
    writeFileSync(tmp, contents, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file) // atomic: a reader never sees a partial file
  }

  /**
   * Publish an entry, stamped with a fresh write id.
   *
   * Every write gets a new one, so a pass that read this file before the write
   * can tell a write happened — which two equal `attemptedAt` values cannot say
   * when the store's clock is injected, or when two writes land in the same
   * millisecond. That is the whole job: identify the writer's publication, not
   * the instant it claims.
   */
  function writeEntry(entry: CacheEntry): void {
    const stamped: CacheEntry = { ...entry, writeId: randomUUID() }
    publish(cacheFile(entry.providerId, dir), JSON.stringify(stamped))
  }

  /**
   * Remove a provider's cache file, under the lock.
   *
   * Deletion is a definitive statement — the human logged out, or no adapter
   * owns this file — so it *claims* the lock rather than waiting for it: a
   * fetch already in flight elsewhere must not be able to publish afterwards
   * and resurrect the provider. Taking the lock away is what stops it: the
   * fetcher checks that it still holds its own token before publishing.
   */
  function deleteEntry(providerId: string): void {
    // Stamp the decision for other stores in THIS process…
    absenceTickets.set(cacheFile(providerId, dir), nextTicket())
    const token = claimLock(providerId)
    try {
      rmSync(cacheFile(providerId, dir), { force: true })
      // …and cancel every refresh that was already under way, here or in any
      // other process. Each such pass announced itself with a presence file
      // before it went to resolve credentials; taking those away is how a
      // decision made now reaches work that started before it.
      cancelPasses(providerId)
    } catch {
      // Nothing to clean up, or someone else already did.
    } finally {
      unlock(providerId, token)
    }
  }

  // ---------------------------------------------------------------- presence
  //
  // A refresh announces itself before it goes off to resolve credentials, by
  // creating one small file named after the provider. The file exists only for
  // the life of that pass, and its own owner removes it.
  //
  // It is there for one question: has this pass been cancelled? A logout — in
  // this process or any other — removes the presence files of every pass in
  // flight, and each of those passes, finding its own file gone, abandons
  // without spending a bearer that now belongs to an account that has left.
  //
  // A crashed process leaves its presence file behind; `pruneCache()` sweeps
  // any older than the lock's own staleness window, the same recovery the lock
  // already relies on.

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

  /** Announce a pass. Returns the file to watch, or null if it cannot be written. */
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

  /** Cancel every pass in flight for this provider, wherever it is running. */
  function cancelPasses(providerId: string): void {
    for (const file of passFilesFor(providerId)) {
      try {
        rmSync(file, { force: true })
      } catch {
        // Its owner got there first; either way that pass is done.
      }
    }
  }

  /**
   * The pid that announced this pass, read back out of its file name:
   * `<providerId>.json.<pid>.<seq>.pass`, parsed off the known prefix, because
   * a provider id may itself contain dots.
   */
  function passOwnerPid(providerId: string, file: string): number | null {
    const name = basename(file)
    const inner = name.slice(`${providerId}.json.`.length, -PASS_SUFFIX.length)
    const pid = Number.parseInt(inner.split('.')[0] ?? '', 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }

  /** Is that process still running? Signal 0 asks without delivering anything. */
  function processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM: it exists, it simply is not ours to signal. ESRCH: it is gone.
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  /**
   * Sweep presence files a **crashed** process left behind.
   *
   * Age alone cannot say that: `getAuth` is π's own credential path and may
   * refresh OAuth credentials over the network, and nothing in the contract
   * bounds it — the 10 s deadline bounds the provider fetch, not the lookup. A
   * lookup slower than the lock's stale window is a slow lookup, not a corpse,
   * and sweeping its announcement would silently cancel a pass whose credential
   * is about to arrive. So the owner has to actually be gone: old *and* dead,
   * with the pid the file names itself after as the evidence.
   *
   * The trade, stated: a reused pid can make a dead pass look alive, and its
   * file then outlives the sweep. That costs one stray byte-sized file that no
   * pass reads and any logout removes — cheaper than cancelling a live
   * credential lookup, which costs a provider its meters until the next pass.
   */
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

  /**
   * Take this provider's lock even if someone holds it. Only deletion does
   * this, and only because deletion supersedes whatever the holder is doing:
   * its result is about to be about an account that is gone.
   */
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

  /**
   * Is this token still the lock's holder? A fetch whose lock was taken — by a
   * logout, or by the 30 s steal after it outran its own timeout — has been
   * superseded, and publishing its result would undo whoever took over.
   */
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
        // Steal a lock older than the stale window: a crashed process, or a
        // fetch that outlived it. There is no crash journal and no cleanup
        // pass; this is the only recovery.
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

  /**
   * Wait, briefly and boundedly, for whoever holds this lock to finish. The cap
   * is the fetch timeout: a holder cannot legitimately take longer, and past the
   * 30 s steal window the lock is takeable anyway.
   */
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

  /** How long the current holder has held this lock. */
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

  /**
   * Release only our own lock. The token is what makes that possible: a fetch
   * declared stale and taken over must never unlock its successor.
   */
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

  /**
   * Record an attempt that produced nothing, keeping whatever good meters are
   * already on disk. The data's own age does not move — only the attempt does —
   * so the row can dim a reading and show how old it is while the TTL still
   * stops a broken provider from being retried on every trigger.
   *
   * The caller must hold this provider's lock: publishing a failure is a write
   * like any other, and a lockless one can undo a winner's success.
   */
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

  /**
   * A failure that happened before any request could be made — the credential
   * lookup itself threw. Recording it still takes the lock, and still defers to
   * a reading another process has just published: if the cache holds a healthy
   * entry younger than the TTL, some process with a working credential proved
   * this provider fine seconds ago, and dimming that would be reporting OUR
   * problem as THEIR outage. If the credential stays broken, the next pass
   * finds that reading aged past the TTL and dims it then.
   */
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

  /**
   * A cache file no registered adapter owns is not data, it is residue — left
   * by a provider whose adapter was removed. A provider with no adapter is
   * absent, and absence cannot depend on the directory never having held that
   * provider, so the file goes rather than being published to every consumer of
   * the snapshot.
   *
   * The consequence, stated plainly: a store owns the directory it is pointed
   * at. Every routine consumer builds one over the registered set, and a
   * consumer that passes a subset should pass a `dir` of its own — which is
   * exactly what the tests do.
   */
  function pruneCache(): void {
    const registered = new Set(adapters.map((adapter) => adapter.providerId))
    for (const providerId of cachedProviderIds(dir)) {
      if (registered.has(providerId)) continue
      // Residue from an adapter that no longer exists: remove it outright.
      try {
        rmSync(cacheFile(providerId, dir), { force: true })
      } catch {
        // Someone else got there first.
      }
      absenceTickets.set(cacheFile(providerId, dir), nextTicket())
      cancelPasses(providerId)
    }
    // Presence files a crashed process left behind, swept on the same staleness
    // rule the lock uses. Every registered provider, not only those with a cache
    // file: an orphaned announcement outlives the reading it was made for.
    for (const adapter of adapters) sweepPasses(adapter.providerId)
  }

  /** What a pass needs to remember about when it began, to know if it still counts. */
  interface Pass {
    readonly providerId: string
    /** Order among this process's decisions. */
    readonly startedTicket: number
    /** This pass's presence file, watched for cancellation. Null if unwritable. */
    readonly presence: string | null
    /** The reading it started from, if any. */
    readonly before: number | null
    /**
     * The write id of that reading, if it had one. Comparing this is how a pass
     * recognizes somebody else's publication without asking either clock — the
     * lock winner is identifiable, not merely later.
     */
    readonly beforeWriteId: string | undefined
  }

  /**
   * Has this pass been overtaken while it was resolving credentials or waiting
   * for the lock? Four ways, and all of them mean "do not fetch, do not write":
   *
   * - somebody **in this process** decided the provider must be absent after we
   *   began — a logout, an API-key account, a file no adapter owns. Our bearer
   *   is for an account that is no longer eligible, so spending it would be both
   *   a wasted authenticated request and a resurrection;
   * - somebody **anywhere** cancelled this pass by removing its presence file,
   *   which is how a logout in another process reaches work that began before
   *   it — and reaches every such pass, not merely the first to look;
   * - the reading we started from has been **deleted**;
   * - somebody **published** a fresher reading than the one we started from, so
   *   fetching again would be the double-fetch the contract forbids and the
   *   result would overwrite theirs with no new information.
   */
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

    // The TTL is checked BEFORE the credential seam: `getAuth` is π's own path
    // and may perform an OAuth refresh over the network, so asking it about a
    // provider whose cache is fresh would put traffic behind a gate whose whole
    // job is to prevent traffic. A logout therefore takes effect within one TTL.
    const cached = readEntry(providerId, dir)
    if (!force && cached !== null && now() - cached.attemptedAt < ttlMs) return

    // Where this pass sits among this process's decisions, the announcement any
    // process can cancel, and the reading it started from. Everything below asks
    // whether the world moved on from these.
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
      // Whatever happened, this pass is over and says so.
      if (pass.presence !== null) rmSync(pass.presence, { force: true })
    }
  }

  /** The pass proper: credentials, lock, fetch, publish — all of it cancellable. */
  async function runPass(adapter: ProviderAdapter, pass: Pass): Promise<void> {
    const providerId = adapter.providerId

    let auth: AuthLike | undefined
    try {
      auth = await options.getAuth(providerId)
    } catch (error) {
      // A credential lookup that THREW is not a logout. π rotates tokens under a
      // file lock, so a transient failure here is expected; deleting the cache
      // would make a logged-in provider vanish and destroy its last good
      // reading. Record a failed attempt instead and degrade honestly.
      noteCredentialFailure(
        pass,
        `credential lookup failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }
    // Only an actual `undefined` means logged out. That is cleaned up here,
    // because the reader never consults credentials.
    if (auth === undefined) return deleteEntry(providerId)
    if (options.credentialType?.(providerId) === 'api_key') return deleteEntry(providerId)
    const bearer = bearerFrom(auth)
    if (bearer === undefined) return deleteEntry(providerId)

    let token = tryLock(providerId)
    if (token === null) {
      // Another process is fetching this provider right now. Wait for it rather
      // than returning a cache we know is about to be replaced: the contract is
      // that the loser serves the WINNER's fresh cache. The wait is bounded by
      // the same timeout the holder's own fetch is bounded by.
      await waitForLock(providerId)
      if (supersededDuringPass(pass)) return // the winner served us
      token = tryLock(providerId)
      // Still held: the holder is slower than its own timeout, or a third
      // process took over. Serve what is on disk; the next trigger is the retry.
      if (token === null) return
    }

    // Holding the lock is not the same as being current: this pass may have
    // spent the meantime inside `getAuth` while a winner published or a logout
    // landed. Ask before spending a request — the check is one file read, and
    // the alternative is a redundant authenticated GET or a resurrection.
    if (supersededDuringPass(pass)) {
      unlock(providerId, token)
      return
    }

    try {
      const result = await adapter.fetchQuota(bearer, {
        // Wall clock, deliberately, even when a clock is injected: this deadline
        // bounds a socket, and `AbortSignal.timeout` measures real time and
        // nothing else. The injected clock governs *data* — ages, the TTL, lock
        // staleness — where a test needs to move time; a fixture clock in 2020
        // must not hand the adapter a deadline that expired six years ago.
        deadline: Date.now() + fetchTimeoutMs,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(adapterLog === undefined ? {} : { log: adapterLog })
      })
      // Between taking the lock and finishing the request, the lock may have
      // been taken away: by a logout (this bearer is now an ex-account's) or by
      // the 30 s steal (this fetch outran its own timeout and someone took
      // over). Either way this result is superseded, and publishing it would
      // undo whoever took over. Say nothing and write nothing.
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
      // An adapter that throws is a bug, not a state; it must still not deny the
      // other providers or leave a lock behind.
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

  /**
   * One pass for one provider, shared with any trigger that overlaps it — with
   * one exception: a `force` request that arrives while an ordinary pass is in
   * flight is not that pass. The ordinary one may be a TTL hit that fetches
   * nothing, and `force` exists for the consumer that needs a number it can rely
   * on, so the forced pass is queued behind it rather than folded into it.
   */
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
      // One provider's failure — even an unexpected one — cannot deny the others.
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
      // Residue is cleared on every pass, whatever its scope: absence must not
      // depend on which providers this particular trigger asked about.
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
