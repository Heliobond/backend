# Heliobond Backend — API Reference

Base URL (local): `http://localhost:3001`

All responses are JSON. Errors use a consistent shape:

```json
{ "error": "bad_request", "message": "project id must be a positive integer" }
```

| Status | `error` code         | When |
|--------|----------------------|------|
| `400`  | `bad_request`        | Invalid params, body, or malformed JSON |
| `401`  | `unauthorized`       | Missing/invalid admin bearer token |
| `404`  | `not_found`          | Unknown route |
| `429`  | `too_many_requests`  | Rate limit exceeded (see `Retry-After`) |
| `500`  | `internal_error`     | Unexpected server error |

## Rate limiting

All `/api/*` endpoints are rate limited per client IP. Responses include the
standard `RateLimit-*` headers; a `429` additionally sets `Retry-After`.
Limits are configurable via environment variables (see
[`.env.example`](./.env.example)): `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`
(public) and `RATE_LIMIT_ADMIN_WINDOW_MS`, `RATE_LIMIT_ADMIN_MAX` (admin).

---

## `GET /health`

Liveness and basic operational visibility. Not rate limited.

**Response `200`**

```json
{
  "status": "ok",
  "uptime_seconds": 3712,
  "started_at": "2026-06-26T18:00:00.000Z",
  "last_cron_run": {
    "name": "score-update",
    "status": "success",
    "at": "2026-06-26T19:00:00.123Z"
  }
}
```

`last_cron_run` is `null` until the first scheduled job runs.

---

## `GET /api/iot/solar/:id`

Simulated solar-panel reading for project `id`. Readings are deterministic per
`(project_id, clock hour)`.

| Param | In   | Type | Rules |
|-------|------|------|-------|
| `id`  | path | int  | Positive integer (`>= 1`) |

**Response `200`**

```json
{
  "power_output_kw": 742.15,
  "efficiency_pct": 74.21,
  "max_power_kw": 1000,
  "timestamp": 1718150400000
}
```

**Errors:** `400` if `id` is not a positive integer.

---

## `GET /api/iot/satellite/:id`

Simulated satellite / vegetation reading for project `id`.

| Param | In   | Type | Rules |
|-------|------|------|-------|
| `id`  | path | int  | Positive integer (`>= 1`) |

**Response `200`**

```json
{
  "forest_density_pct": 68.44,
  "ndvi_score": 0.684,
  "timestamp": 1718150400000
}
```

**Errors:** `400` if `id` is not a positive integer.

---

## `GET /api/projects`

Paginated list of projects with their computed scores and latest readings.

| Param    | In    | Type | Rules | Default |
|----------|-------|------|-------|---------|
| `limit`  | query | int  | Non-negative integer; capped at `100` | `10` |
| `cursor` | query | int  | Non-negative integer (offset) | `0` |

**Response `200`**

```json
{
  "projects": [
    {
      "id": 1,
      "credit_quality": 74,
      "green_impact": 69,
      "power_output_kw": 742.15,
      "efficiency_pct": 74.21,
      "forest_density_pct": 68.44,
      "ndvi_score": 0.684,
      "timestamp": 1718150400000
    }
  ],
  "total": 1,
  "cursor": 10
}
```

`cursor` is present only when more results remain; pass it back as `?cursor=`.

**Errors:** `400` if `limit` or `cursor` is not a non-negative integer.

---

## `GET /api/projects/:id`

Detail for a single project.

| Param | In   | Type | Rules |
|-------|------|------|-------|
| `id`  | path | int  | Positive integer (`>= 1`) |

**Response `200`**

```json
{
  "id": 1,
  "credit_quality": 74,
  "green_impact": 69,
  "power_output_kw": 742.15,
  "efficiency_pct": 74.21,
  "forest_density_pct": 68.44,
  "ndvi_score": 0.684,
  "timestamp": 1718150400000,
  "funding": 482910.55
}
```

**Errors:** `400` if `id` is not a positive integer.

---

## `GET /api/portfolio/:address`

Indexed deposit/withdraw history and current position for an address.

| Param     | In   | Type   | Rules |
|-----------|------|--------|-------|
| `address` | path | string | Non-empty string |

**Response `200`**

```json
{
  "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "current_shares": 42,
  "current_value": 71.25,
  "events": [
    {
      "id": "1234-abcdef",
      "type": "deposit",
      "amount": 500,
      "shares": 42,
      "timestamp": 1718150400000,
      "txHash": "abcdef..."
    }
  ]
}
```

**Errors:** `400` if `address` is empty/missing.

---

## `POST /api/admin/update-scores`

Compute and submit `update_impact_score` transactions to the Soroban contract.
Stricter rate limit than public endpoints.

**Headers**

| Header          | Required | Value |
|-----------------|----------|-------|
| `Authorization` | When `ADMIN_API_KEY` is set | `Bearer <ADMIN_API_KEY>` |

**Body (optional)**

```json
{ "project_ids": [1, 2, 3] }
```

| Field         | Type     | Rules |
|---------------|----------|-------|
| `project_ids` | int[]    | Optional. Array of positive integers. Omit or send `[]` to update **every** registered project. |

**Response `200`**

```json
{
  "updated": 2,
  "results": [
    { "project_id": 1, "tx_hash": "abc123...", "credit_quality": 74, "green_impact": 69 }
  ],
  "errors": []
}
```

Per-project failures are collected in `errors` (the request still returns `200`);
Soroban does not support multi-call batching, so transactions are submitted
sequentially.

**Errors:**
- `400` if `project_ids` is present but not an array of positive integers, or the JSON body is malformed.
- `401` if `ADMIN_API_KEY` is set and the bearer token is missing/incorrect.
