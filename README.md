# URL Shortener with Analytics — Project Documentation

A backend-focused URL shortener built to deeply understand core backend engineering
decisions: encoding strategy, caching, asynchronous analytics, and rate limiting.

**Stack:** Node.js, TypeScript, Express, PostgreSQL (raw SQL via `pg`, no ORM), Redis

---

## 1. Architecture Overview

The system has two distinct flows with very different performance requirements:

### Write path — `POST /shorten`
Happens once per link created. Latency of a few hundred ms.

```
Client → POST /shorten { longUrl }
       → Rate limiter (10 req / 60s per IP)
       → Validate URL
       → INSERT INTO links (long_url) RETURNING id
       → encodeBase62(id) → code
       → UPDATE links SET code = ... WHERE id = ...
       → Respond { shortUrl, code }
```

### Read path — `GET /:code`
Happens on every click — potentially thousands of times per link. Latency is
minimal (target: low milliseconds).

```
Client → GET /:code
       → Rate limiter (100 req / 60s per IP)
       → Check Redis cache (link:{code})
           HIT  → skip DB entirely
           MISS → SELECT FROM links WHERE code = ... → cache it (TTL 1hr)
       → Fire-and-forget: increment click counter in Redis
       → 302 redirect to long_url
```

**Why two different rate limits?** `/shorten` writes to the database and should be
limited more strictly. `/:code` is read-heavy, mostly cache-served, and represents
legitimate traffic (including viral links), so it tolerates a much higher ceiling.

---

## 2. Database Schema

```sql
CREATE TABLE links (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(10) UNIQUE,              -- nullable; see Section 3
    long_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    click_count BIGINT NOT NULL DEFAULT 0  -- durable, periodically-flushed total
);
```

Design notes:

- **`BIGSERIAL` / `BIGINT`, not `SERIAL` / `INT`** — cheap insurance against ever
  hitting a 32-bit integer ceiling (~2.1 billion) on either link count or click count.
- **`code` has no extra `CREATE INDEX`** — `UNIQUE` already creates an index
  automatically in Postgres. Adding a second explicit index on the same column wastes
  disk space and slows down every write for zero benefit.
- **`code` is nullable** — required for the insert strategy below. Postgres treats
  multiple `NULL`s as non-conflicting under a `UNIQUE` constraint, while two empty
  strings `''` would collide.
- **`long_url` is `TEXT`, not `VARCHAR(n)`** — no schema-level cap; URL length
  validation belongs in the application layer, not an arbitrary DB constraint.
- **`TIMESTAMPTZ`, not `TIMESTAMP`** — stores in UTC internally, avoiding an entire
  category of timezone bugs.

---

## 3. Short Code Generation: Base62, Not Random

### The problem with random strings

Picking random characters per code requires checking for collisions on every create
(read-then-write loop), and under concurrency two requests can race to claim the
same code. The probability of collision grows faster than intuition suggests (the
birthday problem) — at scale, this isn't a hypothetical.

### The chosen approach

1. Let Postgres generate a unique numeric `id` via `BIGSERIAL` (uniqueness is free —
   that's what a primary key guarantees).
2. Convert that `id` into a string using **base62 encoding** — a positional number
   system using `0-9a-zA-Z` (62 symbols), the same way base10 uses 10 symbols.
3. Base62 is a **deterministic, one-to-one** function: the same input always produces
   the same output, and two different inputs can never collide. Uniqueness is
   *inherited* from the `id`, not manufactured by the encoding step.

**Why base62 and not base64?** Base64 includes `+`, `/`, `=` — characters with
special meaning in URLs. Base62 deliberately excludes them so codes never need
escaping.

### Implementation (`src/utils/base62.ts`)

```typescript
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE = ALPHABET.length; // 62

export function encodeBase62(num: number): string {
  if (num === 0) return ALPHABET[0];
  let result = '';
  while (num > 0) {
    const remainder = num % BASE;
    result = ALPHABET[remainder] + result;
    num = Math.floor(num / BASE);
  }
  return result;
}

export function decodeBase62(str: string): number {
  let result = 0;
  for (const char of str) {
    const value = ALPHABET.indexOf(char);
    result = result * BASE + value;
  }
  return result;
}
```

### Known tradeoff: predictability

Encoding the raw `id` means codes are sequential and enumerable (`id=1000` → `g8`,
`id=1001` → `g9`). This is a real, acknowledged weakness, not an oversight.
**Not yet implemented**, but the standard mitigation is to bit-shuffle or XOR the
`id` before encoding, breaking the visible sequential pattern while keeping the
encoding deterministic and reversible. Worth adding if codes ever guard
sensitive/private destinations.

### The insert sequencing problem

`code` can't be computed before insert (no `id` yet) and `code` can't be left out
of insert if it's `NOT NULL`. Solved by:

1. Making `code` nullable.
2. `INSERT INTO links (long_url) VALUES ($1) RETURNING id` (omit `code`, defaults
   to `NULL`).
3. Compute `encodeBase62(id)`.
4. `UPDATE links SET code = $1 WHERE id = $2`.

This is a two-round-trip write. Deliberately not optimized further (e.g.
pre-fetching the ID via `nextval()` for a single round-trip) because `/shorten` is a
low-frequency write path — optimization effort belongs on the high-frequency read
path instead.

**Known limitation:** no deduplication. Shortening the same long URL twice produces
two different codes/rows. This was an implicit decision, not actively designed —
worth revisiting if duplicate-URL behavior matters later.

---

## 4. Redirect Behavior: 302, Not 301

This project deliberately uses `302 Found`, not `301 Moved Permanently`.

**The conflict:** `301` tells browsers "this is permanent," so browsers cache it
aggressively — on repeat visits, the browser redirects locally and **never contacts
the server again**. Since click analytics is a core requirement, this would cause
severe undercounting: only the first click per browser per link would ever be
observed.

`302` tells the browser not to cache the redirect, so every click reliably reaches
the server and can be counted.

This is a direct tradeoff between two real goals: SEO/performance benefit (`301`)
vs. accurate analytics (`302`). They are not independently choosable — `301`'s
SEO value and its browser-caching behavior are the same underlying mechanism, not
two separable effects. Given this project's analytics requirement, `302` is the only
consistent choice.

---

## 5. Caching Strategy: Redis Cache-Aside

### Why not a plain in-memory JS object?

Two failure modes a plain object can't solve:

1. **Dies with the process.** Any server restart/deploy wipes it completely (cold
   start — every link looks "uncached" again until traffic slowly rebuilds it).
2. **Doesn't scale across instances.** Running multiple Node processes (for
   reliability/throughput) means each one has its own private, disconnected memory.
   A lookup cached on Server A is invisible to Server B — no shared benefit.

Redis solves both: it's a separate, shared process that all app instances connect
to, the same way they all share one Postgres database.

**Important distinction:** Redis is backend infrastructure, unrelated to the user's
*browser* cache. A user closing their browser has zero effect on Redis — these are
two unconnected systems that happen to both use the word "cache."

### The pattern: cache-aside (lazy loading)

```
GET /:code
  1. Check Redis: link:{code}
  2a. HIT  → use cached value, skip Postgres entirely
  2b. MISS → query Postgres → write result into Redis → respond
```

The very first click on any link is always a cache miss — it "warms" the cache for
every subsequent click.

### Key design

- **Namespaced keys** (`link:{code}`) — Redis is a flat key-value store with no
  concept of tables; namespacing prevents collisions between different kinds of
  cached data (e.g. vs. `clicks:{code}` used for analytics).
- **TTL: 1 hour**, set via `SETEX` (atomic set + expiry in one operation). Why not
  cache forever? Memory is finite — Redis is RAM-backed, and caching every link
  forever wastes memory on rarely-clicked links. A TTL also bounds staleness risk
  if a future "edit destination" feature is ever added.
- **Why not too short (e.g. 10s)?** A cache that expires almost immediately gets
  hit on nearly every request without saving meaningful database load — defeating
  the purpose of caching at all.

### Failure handling: accelerator, not source of truth

Postgres is the **source of truth** — if it's down, the system genuinely cannot
function correctly, so it's correct to fail loudly.

Redis here is purely an **accelerator** — it holds no data that doesn't also exist
in Postgres. If Redis is unreachable, the system should **degrade gracefully**, not
crash:

- On startup, a failed Redis connection is caught and logged; the server starts
  anyway and serves traffic without caching.
- Every individual cache read/write (`getCachedLongUrl`, `setCachedLongUrl`) is
  wrapped in try/catch, falling back silently to treating it as a cache miss.

**General principle:** a dependency that only improves performance should degrade
gracefully; a dependency that holds your actual data should fail loudly.

### Implementation (`src/db/cache.ts`)

```typescript
const LINK_CACHE_TTL_SECONDS = 3600;

export async function getCachedLongUrl(code: string): Promise<string | null> {
  try {
    return await redisClient.get(`link:${code}`);
  } catch (err) {
    console.error('Redis GET failed, falling back to DB:', err);
    return null;
  }
}

export async function setCachedLongUrl(code: string, longUrl: string): Promise<void> {
  try {
    await redisClient.setEx(`link:${code}`, LINK_CACHE_TTL_SECONDS, longUrl);
  } catch (err) {
    console.error('Redis SETEX failed, continuing without caching this entry:', err);
  }
}
```

### Open tradeoff: awaited vs. fire-and-forget cache writes

The redirect route currently `await`s the Redis write before responding. This
guarantees the cache is populated by the time the response is sent (the very next
click is guaranteed a hit), at the cost of a few milliseconds added to the
*current* request. The alternative — fire-and-forget — would shave those
milliseconds but introduces a narrow race window where a near-simultaneous second
click could also miss the cache. Given the small time difference and the rarity of
the race, this was a close call; `await` was kept for simplicity and a more
predictable consistency model while learning. Worth revisiting under real load
testing.

---

## 6. Click Analytics: Buffer-and-Flush

### Requirement scope

Only a **raw total click count** per link is needed — no per-event log, no
timestamps, no referrer data. This shapes the entire design.

### Why not log every click as a row?

An event-log approach (one row per click) would mean a full Postgres `INSERT` on
every single redirect — exactly the per-request database write the caching layer
was built to avoid. Since only an aggregate count is needed, a **running counter**
is sufficient and far cheaper.

### Why not just increment Postgres directly on every click?

Same problem — a `click_count = click_count + 1` write on every redirect still
means a database round-trip per click, on the hottest path in the system.

### Why not just increment Redis forever, with no flush to Postgres?

Redis would become the unintentional source of truth for this data. If Redis is
only ever meant to be an accelerator (cache), letting it hold the *only* copy of
click counts contradicts that role — a Redis crash with no persistence configured
would mean **permanent, unrecoverable data loss**.

### The chosen design: buffer in Redis, flush to Postgres periodically

```
On every click (fire-and-forget, not awaited):
  Redis: INCR clicks:{code}

Every 2 minutes (background job, independent of any request):
  For each clicks:{code} key:
    count = GET clicks:{code}
    UPDATE links SET click_count = click_count + count WHERE code = {code}
    DECRBY clicks:{code} count   ← not DELETE or SET 0
```

**Why `DECRBY` the exact processed amount, not delete/reset to 0?** Between reading
the count and finishing the Postgres write, new clicks can still be arriving and
incrementing the same key in real time (the flush job runs independently while the
server keeps serving live traffic). Deleting or zeroing the key after read would
silently erase any increments that landed during that window. Subtracting exactly
the amount already processed preserves those in-flight increments for the next
flush cycle.

### Why fire-and-forget specifically here (unlike the cache write)?

The increment's result isn't needed by anyone until the next scheduled flush,
minutes later — there's no "next request" depending on it being done immediately.
Losing the race on "is it incremented yet" has zero user-facing consequence, unlike
the cache write where the *very next* request benefits from it being done.

The increment function wraps its own try/catch internally (rather than relying on
the route handler's try/catch), since by the time a fire-and-forget promise
settles, the route's try/catch block has likely already finished executing —
an unhandled rejection here would otherwise be an invisible, hard-to-trace crash
risk, disconnected from any request/response cycle.

### Why a 2-minute flush interval, not 30 minutes or 10 seconds?

The flush interval is independent of redirect speed — the user is never waiting on
the flush job, regardless of how often it runs. What the interval actually trades
off is:

- **Durability risk window** — if Redis crashes before a flush, all increments
  since the last flush are lost permanently. Shorter interval = smaller max loss.
- **Postgres write frequency** — longer interval = fewer aggregate `UPDATE`s.

Since aggregate `UPDATE`s are cheap (one row per link, not bulk event data) and only
a rough total is required (not perfect precision), a short interval (1–2 minutes)
meaningfully reduces the loss window without materially stressing Postgres.

### Implementation

`src/db/cache.ts`:
```typescript
export async function incrementClickCount(code: string): Promise<void> {
  try {
    await redisClient.incr(`clicks:${code}`);
  } catch (err) {
    console.error('Redis INCR failed, click not counted:', err);
  }
}
```

`src/jobs/flushClickCounts.ts`:
```typescript
export async function flushClickCounts(): Promise<void> {
  const keys = await redisClient.keys('clicks:*');
  if (keys.length === 0) return;

  for (const key of keys) {
    const code = key.replace('clicks:', '');
    const countStr = await redisClient.get(key);
    const count = countStr ? parseInt(countStr, 10) : 0;

    if (count > 0) {
      await pool.query(
        'UPDATE links SET click_count = click_count + $1 WHERE code = $2',
        [count, code]
      );
      await redisClient.decrBy(key, count);
    }
  }
}
```

`src/jobs/scheduler.ts` — runs the above every 2 minutes via `setInterval`, with its
own try/catch around each run so a single failed flush doesn't crash the process or
silently halt all future scheduled runs.

**Known scaling caveat (not yet addressed):** if this app is ever run as multiple
server instances, each instance currently runs its own independent `setInterval`
flush job. This would cause redundant/overlapping flushes. A production fix would
designate a single flusher (e.g. a dedicated worker process, or a Redis-based lock
to ensure only one instance flushes at a time).

---

## 7. Rate Limiting: Sliding Window via Redis Sorted Sets

### Two things any rate limiter needs

1. **An identity** to key by — here, IP address (`req.ip`), reasonable for an
   anonymous/public API. Known weakness: shared IPs (corporate NAT, VPNs) are
   indistinguishable from each other; not addressed in this version.
2. **A record of recent activity** tied to that identity, with a sense of time.

### Why not fixed window?

Naive approach: keep a counter per IP, reset it to 0 at fixed clock boundaries
(e.g. every 60 seconds on the minute). This has a structural flaw called the
**boundary problem**: a client can send a full quota of requests right before a
reset, and another full quota right after — e.g. 5 requests at `12:00:59` and 5
more at `12:01:01`. Each 60-second *clock window* independently sees only 5
requests (compliant), but the **true** rate is 10 requests in ~2 seconds — double
the intended limit, exploited just by knowing when the window resets.

### The fix: sliding window

Instead of clock-aligned windows, every request asks: "how many requests has this
identity made in the last 60 seconds, counting backward from right now?" There's no
fixed boundary to game, because there is no fixed boundary.

This requires storing a **timestamp per request**, not a single counter — a
counter alone has no memory of *when* events happened.

### Implementation via Redis sorted sets (ZSET)

A sorted set stores members with a numeric score and keeps them ordered by it.
Using the timestamp as both score and member enables an efficient range query for
"everything in the last 60 seconds."

```
Key: ratelimit:{ip}:{path}

ZREMRANGEBYSCORE key 0 (now - windowMs)   → discard expired entries
ZCARD key                                  → count what's left (all valid now)
ZADD key {score: now, value: unique}       → record this request
EXPIRE key windowSeconds                   → refresh TTL (cleanup for idle IPs)
```

**Why remove expired entries before counting, not after?** If old entries are still
present when counting, they inflate the count with data that's no longer supposed
to exist in the window — e.g. 2 stale entries from 90s/85s ago plus 3 genuinely
recent ones would `ZCARD` to 5 and incorrectly trigger a block at a limit of 5, when
only 3 requests are actually within the valid window. (Equivalently correct
alternative: use `ZCOUNT` with an explicit score range instead of removing first —
but removing first also reclaims memory and keeps the set bounded, which a
range-query-only approach doesn't.)

**Why a random suffix on the stored value (`${now}-${Math.random()}`), not just the
timestamp?** Sorted set *members* must be unique. Two requests landing in the same
millisecond would otherwise overwrite each other (the second `ZADD` would silently
replace, not add to, the first) — undercounting real concurrent traffic.

**Why refresh the TTL on every request, set to match the window size exactly (not
some longer arbitrary value)?** The TTL's only job is cleaning up entirely after an
IP goes silent — trimming already handles stale data within an *active* key. Since
any entry older than the window is already meaningless (and gets trimmed on the
next request anyway), the moment `windowSeconds` have passed with no new request,
the key is guaranteed to hold nothing valid — that's precisely when it's safe to
delete. A TTL longer than the window just leaves a dead key sitting in memory
longer than necessary; a TTL shorter than the window risks deleting a key that still
holds valid entries. The TTL is *derived from* the window, not an independent
choice. Critically, a TTL set once and never refreshed only protects against
inactivity from the *first* request — an IP making continuous requests needs the
TTL re-issued on every request to correctly represent "idle for N seconds."

### Fail open, not fail closed

If Redis is unreachable, the rate limiter middleware logs the error and calls
`next()` — allowing the request through rather than blocking all traffic. Same
accelerator-vs-source-of-truth reasoning as caching: rate limiting is a protective
feature, not core functionality. (Security-critical limiters — e.g. login attempt
throttling — often choose the opposite, fail-closed, since unlimited traffic during
an outage is dangerous there. Fail-open is the appropriate default for this use
case.)

### Per-route, per-IP keying

Keys include the route path (`ratelimit:{ip}:{path}`), not just the IP, so a burst
of redirects against one link doesn't consume an IP's separate `/shorten` quota.

### Implementation (`src/middleware/rateLimiter.ts`)

```typescript
export function rateLimiter(limit: number, windowSeconds: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip;
    const key = `ratelimit:${ip}:${req.path}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    try {
      await redisClient.zRemRangeByScore(key, 0, now - windowMs);
      const count = await redisClient.zCard(key);

      if (count >= limit) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }

      await redisClient.zAdd(key, { score: now, value: `${now}-${Math.random()}` });
      await redisClient.expire(key, windowSeconds);
      next();
    } catch (err) {
      console.error('Rate limiter error, allowing request through:', err);
      next(); // fail open
    }
  };
}
```

Applied with different limits per route:
```typescript
router.post('/shorten', rateLimiter(10, 60), ...);   // stricter — writes to DB
router.get('/:code', rateLimiter(100, 60), ...);     // looser — mostly cache reads
```

### Middleware ordering: rate limiter first, always

Rate limiting runs **before** the cache check and before any database access. The
reasoning is cost-asymmetry, not just "fewer Redis calls": if the cache check ran
first and missed, a request that was going to be rejected anyway would have already
triggered an expensive Postgres query. The rate limiter's job is to reject cheaply,
*before* anything costly downstream runs — so it belongs at the very front of the
pipeline. General principle: order middleware from cheapest-and-most-rejecting to
most-expensive-and-most-permitting.

---

## 8. Project Structure

```
url-shortener/
├── src/
│   ├── routes/
│   │   ├── shorten.ts       — POST /shorten
│   │   └── redirect.ts      — GET /:code
│   ├── db/
│   │   ├── pool.ts          — Postgres connection pool
│   │   ├── redisClient.ts   — Redis connection
│   │   ├── links.ts         — all SQL queries against `links`
│   │   └── cache.ts         — Redis cache-aside + click increment helpers
│   ├── middleware/
│   │   └── rateLimiter.ts   — sliding-window rate limiter factory
│   ├── jobs/
│   │   ├── flushClickCounts.ts  — buffer → Postgres flush logic
│   │   └── scheduler.ts         — setInterval wrapper, error-isolated
│   ├── utils/
│   │   └── base62.ts        — pure encode/decode functions
│   └── index.ts             — app wiring, startup sequencing
├── tsconfig.json
├── .env / .env.example
└── package.json
```

**Guiding principle:** separation by responsibility, not file type. `utils/` holds
pure functions (no side effects, trivially testable). `db/` is the only layer that
talks to Postgres/Redis directly. `routes/` orchestrates — calling into `db/` and
`utils/` — but contains minimal logic of its own.

### Postgres connection pool (`src/db/pool.ts`)

```typescript
export const pool = new Pool({
  // ...
  max: 20,                    // caps simultaneous connections (Postgres default ceiling: 100, shared across all clients)
  idleTimeoutMillis: 30000,   // release unused connections after 30s
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});
```

A pool exists instead of a single shared connection because Postgres connections
process one query at a time — without pooling, concurrent requests would queue
behind each other even though Postgres itself could handle them in parallel across
separate connections. The error handler prevents an unexpected dropped connection
from crashing the entire Node process.

### Startup sequencing (`src/index.ts`)

Redis connection failure at startup is caught and logged, not allowed to crash or
block server startup — consistent with Redis's accelerator role throughout this
project.

---

## 9. Known Limitations / Future Work

These were identified during the build but deliberately deferred, because some are either
out of scope for the core learning goals or because they're genuine "decide
later" tradeoffs:

- **No deduplication** on `/shorten` — identical long URLs get separate codes.
- **No code-unguessability mitigation** — codes are sequential/enumerable since
  they directly encode the row `id`. Mitigation (XOR/bit-shuffle before encoding)
  was discussed but not implemented.
- **Multi-instance flush job collision** — running multiple server instances would
  currently run multiple independent flush jobs against the same data with no
  coordination.
- **IP-based identity weaknesses** — shared IPs (NAT, VPN) are rate-limited as a
  single identity.
- **Cache write await vs. fire-and-forget** — currently awaited for consistency;
  revisit under real load.
- **No automated tests yet** — Jest/Supertest, consistent with the RealWorld API
  project's testing approach, would be the natural next step.
