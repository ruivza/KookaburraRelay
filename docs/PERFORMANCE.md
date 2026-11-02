# Performance

`scripts/bench.mjs` measures the device delivery path, `POST /v1/jobs` and the asynchronous worker behind it, against a real gateway and PostgreSQL. This page records how it works and the baseline numbers that later changes are compared against.

## Running

```sh
sh scripts/test-docker.sh node scripts/bench.mjs                 # default: 2000 jobs, both scenarios
sh scripts/test-docker.sh node scripts/bench.mjs --scenario phased --jobs 500 --concurrency 1
GATEWAY_DATABASE_URL='postgresql://relay_test:replace-me@127.0.0.1:5432/relay_test' npm run bench
```

The JSON report goes to stdout (or `--out file.json`), progress and a short summary to stderr. Each scenario creates and drops its own `bench_*` schema; point it only at a disposable database. The Docker form needs nothing but Docker and a POSIX shell, and starts a fresh PostgreSQL for every run.

| Option | Default | Meaning |
| --- | --- | --- |
| `--jobs` | 2000 | Requests sent, one per seeded device (at most 9000; the queue holds 10000) |
| `--concurrency` | 32 | Requests in flight (at most 64; the gateway rejects a 65th concurrent request) |
| `--provider-delay` | 50 | Milliseconds the simulated APNs provider takes to answer `{status:200}` |
| `--sources` | 256 | Distinct client addresses sent in `X-Forwarded-For` |
| `--scenario` | `all` | `concurrent`, `phased`, or both |
| `--timeout` | 600 | Seconds to wait for deliveries before reporting them incomplete |

## Method

- **Gateway.** `createGateway()` from `src/server.js`, unmodified, listening on loopback, with `trustedProxies: '127.0.0.1'`. The only injected dependency is `providerFactory`: a fake APNs provider that answers every delivery `{status:200}` after `--provider-delay` milliseconds. The default application gets an APNs channel through `applications.update()`, as in the test suite.
- **Devices.** One device enrolls and confirms through the real HTTP endpoints. Its row is then cloned in one `INSERT` into `--jobs` verified registrations, each with its own id, device id, token hash, and 43-character delivery credential. Cloning avoids the enrollment limit (60 per hour per address). All clones share the template's sealed device token, which the fake provider ignores. `ANALYZE registrations` runs before the load starts.
- **Load.** A worker thread, so the client does not run on the gateway's event loop, sends one `POST /v1/jobs` (`kind: sync`, unique `requestId`) per device over keep-alive connections, `--concurrency` at a time. Each device gets one job, because a registration allows one active job per 60 seconds. Client addresses rotate through `--sources` addresses in 198.18.0.0/15 (RFC 2544 benchmarking range), so per-address limits are not the bottleneck. Latency is measured in the client, from request start to full response.
- **Scenarios.**
  - `concurrent`: the gateway starts normally (`autoStart: true`), so delivery workers, monitoring, alerts, and maintenance run while requests arrive. Reports HTTP throughput under worker contention and the time from the first enqueue (`min(created)`) until the last job is `accepted` (`max(updated)`), read from `delivery_jobs`.
  - `phased`: the gateway starts with `autoStart: false`, so requests only enqueue. After the last response and its audit writes, `queue.start()` drains the queue. Reports HTTP throughput without worker contention, then drain time and deliveries per second.
- **Database round-trips.** `pg.Client.prototype.query` is wrapped to count every statement sent by the gateway's pool, including `BEGIN`, `COMMIT`, and advisory locks. Counts are grouped by statement text (parameter lists normalized). The bench's own polling connection is excluded. In `phased`, the request window covers the HTTP phase and the audit writes that follow it, and the delivery window covers the drain, so the two are separate. In `concurrent`, requests and deliveries overlap, so only the combined count per job is reported. Each section lists every statement with its count per operation.

## Caveats

- Absolute numbers depend on the machine, Docker's VM, and whatever else is running. Compare runs on the same machine, preferably several, and read the spread before calling a change an improvement.
- The gateway and the load generator share one Node process (separate threads) and one container. PostgreSQL runs in a second container with default settings (`shared_buffers` 128MB, `synchronous_commit` on, `fsync` on), on the same host.
- Request audit rows are sampled by the gateway: at most 120 per minute and 8 in flight; the rest are dropped (`auditLogsDropped`). Per-request round-trip counts therefore depend on request rate and run length. The `INSERT INTO gateway_logs` line in the breakdown shows how many were written.
- The fake provider has fixed latency and never fails, so retries, provider errors, and HTTP/2 connection behaviour are not exercised.
- PostgreSQL starts empty for each run; `delivery_jobs`, `limits`, and `abuse_quotas` contain only this run's rows.

## Comparing results

Database round-trip counts are deterministic for a given workload: they varied by less than 0.1 across every baseline run. Compare them directly; any change should be explained by the statement breakdown. Throughput and latency are not: on the baseline machine they varied by a factor of two or more between identical runs. Compare the median of at least three runs on the same machine against the median below, and treat differences inside the baseline range as noise.

## Baseline: v0.1.2

Gateway source as on `main` at `faf95b6` (the run reports `faf95b6-dirty` because the bench files were not yet committed; `src/` was unmodified). Recorded 2026-11-02, 13:59–14:16 UTC.

| Environment | |
| --- | --- |
| Host | Windows 11 Pro, Docker Desktop 29.8.2 (WSL 2, kernel 6.18.54.1), Intel Core i9-10885H @ 2.40GHz, 16 logical CPUs, 31 GiB |
| Gateway | `node:24-alpine` (Node.js v24.22.2); database pool 10 connections; 4 delivery workers |
| Database | `postgres:18-alpine` (PostgreSQL 18.6), default settings, separate container on the same Docker network |
| Other load | Containers from parallel development sessions were present during the runs; they could not be ruled out as a source of noise |

Command, run five times, each with fresh containers:

```sh
sh scripts/test-docker.sh node scripts/bench.mjs
```

Defaults: 2000 jobs, concurrency 32, provider delay 50 ms, 256 client addresses. Median of the five runs, with the range:

| Metric | `concurrent` | `phased` |
| --- | --- | --- |
| HTTP throughput, req/s | 80.7 (52.7–104.7) | 89.2 (73.2–116.6) |
| Latency p50, ms | 356 (285–587) | 349 (262–420) |
| Latency p90, ms | 552 (358–846) | 423 (306–572) |
| Latency p99, ms | 614 (492–1334) | 673 (386–737) |
| HTTP statuses | 202 for all 2000, every run | 202 for all 2000, every run |
| First enqueue to all 2000 accepted, s | 57.0 (50.7–72.0) | n/a |
| Queue drain after load, s | n/a | 35.4 (34.8–43.8) |
| Deliveries accepted/s | 35.1 (27.8–39.4) | 56.5 (45.7–57.5) |
| DB round-trips per `/v1/jobs` request | n/a | 39.25 (all runs) |
| DB round-trips per delivery | n/a | 24.96 (24.93–24.98) |
| DB round-trips per job, request and delivery | 64.2 (64.20–64.23) | n/a |

Supplementary runs on the same machine:

| Command options | Result |
| --- | --- |
| `--scenario phased --jobs 500 --concurrency 1` | 43.7 req/s; latency p50 21.1 ms, p90 30.1 ms, p99 37.8 ms; 39.99 round-trips per request (more audit rows and new addresses per request at this size); drain 57.1 deliveries/s |
| `--scenario concurrent --jobs 8000` | 74.5 req/s over 107 s; p50 376 ms, p99 1060 ms; all 8000 returned 202, no gateway rejections; all accepted 277 s after the first enqueue (28.9/s); 64.05 round-trips per job |

### Observations

- **Requests serialize.** At concurrency 1 a request takes about 21 ms. At concurrency 32 the median throughput is only 1.8–2.0 times the serial rate (1.2–2.7 across runs), while p50 latency grows to roughly 350 ms, which is queueing. Each request runs four transactions. The three `limit()` calls (per address, per application, per registration) each take the same global advisory lock `72841105`, and enqueue takes two more global locks, `72841104` and `72841103`. During the request phase the gateway container (gateway plus load thread) used 0.7–1.0 CPU cores and PostgreSQL about 0.9 (sampled with `docker stats`), so the 16 CPUs were far from busy. Whether the gateway's single event loop is a limit was not measured separately.
- **Per-request round-trips.** 38 for every request, plus 1 when the registration's rate-limit key is new (`SELECT count(*) FROM limits`), plus 1 for each new client address, plus 2 when the request's audit row is written (at most 120 per minute). That gives 39.25 at 2000 requests over 256 addresses, and 41.6 in a 100-request smoke run.
- **Delivery is latency bound.** Four workers and a 50 ms provider cap delivery at 80 per second. The drain reached 56.5/s, about 71 ms per delivery per worker, so about 21 ms is spent outside the provider on 25 sequential round-trips. With requests arriving at the same time, workers compete for the same 10-connection pool and the rate fell to 35/s. During the drain both containers were mostly idle (about 0.3 cores each).
- **Global admission cap not reached.** `abuse.admit()` allows 6000 requests per minute in total, i.e. 100 req/s sustained over a minute. The 8000-job run sustained 74.5 req/s and saw no `request_global` rejections, and the 2000-job runs cannot reach 6000 in a minute. Single 2000-job runs did reach 104.7 and 116.6 req/s for 17–19 seconds, so once the hot path gets faster, the cap will become the limit for runs above 6000 jobs. The bench reports such rejections under `http.rejections` and `gatewayRejections`.

Round-trips per `/v1/jobs` request (`phased`, 2000 requests):

| Per request | Statement | Caller |
| --- | --- | --- |
| 4 + 4 | `BEGIN`, `COMMIT` | three `limit()` calls, enqueue |
| 3 | `SELECT pg_advisory_xact_lock(72841105)` | `limit()`, global |
| 3 | `SELECT * FROM limits WHERE key=?` | `limit()` |
| 3 | `INSERT INTO limits ... ON CONFLICT` | `limit()` |
| 1.13 | `SELECT count(*) n FROM limits` | `limit()` capacity check for new keys |
| 3 | `INSERT INTO abuse_quotas ... ON CONFLICT` | `abuse.task()`: global, application, device daily quotas |
| 2 | `SELECT * FROM applications WHERE id=?` | `applications.current()` in `device()` and enqueue |
| 2 | `SELECT settings FROM application_notifications` | `applications.capabilities()` in `device()` and enqueue |
| 1.06 | `SELECT 1 FROM applications WHERE id=?` | `access.policy()`, sampled audit |
| 1 each | `access_policies`, `trusted_servers`, `application_quotas` lookups | `access.delivery()`, `abuse.effective()` |
| 1 | `SELECT * FROM registrations WHERE delivery_hash=?` | credential lookup |
| 1 + 1 | `SELECT pg_advisory_xact_lock(72841104)`, `(72841103)` | enqueue, global |
| 1 | `SELECT * FROM registrations ... FOR UPDATE` | enqueue |
| 1 each | dedupe lookup, queue-capacity `count(*)`, active-job check | enqueue |
| 1 + 1 + 1 | `INSERT INTO delivery_jobs`, `UPDATE registrations SET last_sent`, reread job | enqueue |
| 0.06 | `INSERT INTO gateway_logs` | sampled audit |

Round-trips per delivery (`phased` drain):

| Per delivery | Statement | Caller |
| --- | --- | --- |
| 5 | `SELECT * FROM applications WHERE id=?` | four `applications.current()` checks, `applications.resolve()` |
| 5 | `SELECT * FROM delivery_jobs WHERE id=?` | initial read, three state rechecks, final read |
| 3 | `SELECT settings FROM application_notifications` | two `capabilities()` checks, `notifications()` |
| 2 + 1 + 1 | `INSERT INTO abuse_quotas`, `BEGIN`, `COMMIT` | `abuse.attempt()` |
| 1 each | `application_quotas`, `app_channels`, `trusted_servers`, registration read, registration recheck after send | quota, channel, access, revocation checks |
| 1 + 1 | `UPDATE delivery_jobs` to `sending`, then to the result | claim, completion |
| 0.96 | `SELECT id FROM delivery_jobs ... LIMIT ?` | worker poll, amortized |

The full per-statement breakdown for any run is in the JSON report under `roundTrips`.
