# Removing the legacy `/api/*` routes

`/api/*` is deprecated in favour of `/v1/*` and sunsets on **2027-01-01T00:00:00Z**
(see `src/middleware/versioning.ts`). The two mount tables have already drifted
(e.g. `/api/portfolio` requires `apiKeyAuth`, `/v1/portfolio` does not; admin
mounts differ), so removing the legacy table shrinks the surface to secure and test.

## Phases

1. **Measure (now).** `legacyApiUsage` increments `legacy_api_requests_total{path}`
   and logs each request. Watch it in Prometheus/Grafana; contact remaining callers.
2. **Announce.** Migration notes live in `API.md` and `CHANGELOG.md`.
3. **Sunset (2027-01-01).** No deploy needed: `legacyApiUsage` starts answering
   `410 Gone` with a `Link: </v1/...>; rel="successor-version"` header.
4. **Delete (removal PR, target: first release after 2027-01-01).**
   - In `src/index.ts` delete the whole "Legacy /api paths" block (the
     `app.use("/api...")` lines and `app.use("/api/admin", requestTimeout(...))`).
   - Delete `deprecationHeaders`, `legacyApiUsage`, `legacyPathLabel` and
     `LEGACY_SUNSET_DATE` from `src/middleware/versioning.ts`, and the
     `legacyApiRequestsTotal` counter from `src/lib/prometheus.ts`.
   - Point tests that mount routers under `/api/...` (for example
     `src/__tests__/admin*.test.ts`) at `/v1/...`; keep one test asserting `/api/*`
     is no longer routed (404).
   - Remove the deprecation notes from `API.md` and add a `BREAKING CHANGE:` entry.

Do not delete before confirming `legacy_api_requests_total` is flat at zero.
