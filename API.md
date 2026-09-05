# Heliobond Backend — API Reference

Base URL (local): `http://localhost:3001`

All REST responses default to JSON unless an export format (e.g. `format=csv`) is explicitly requested.

Errors follow a consistent structure:

```json
{
  "error": {
    "code": "bad_request",
    "message": "project id must be a positive integer"
  }
}
```

`code` is a stable, machine-readable identifier for programmatic handling; `message` provides human-readable detail.

| Status | `error.code`           | When                                                         |
| ------ | ---------------------- | ------------------------------------------------------------ |
| `400`  | `bad_request`          | Invalid parameters, body validation error, or malformed JSON |
| `401`  | `unauthorized`         | Missing or invalid authentication credentials / bearer token |
| `403`  | `forbidden`            | Client IP not whitelisted or role insufficient               |
| `404`  | `not_found`            | Resource or unknown route does not exist                     |
| `429`  | `too_many_requests`    | Rate limit exceeded (check `Retry-After` header)             |
| `500`  | `server_misconfigured` | Admin endpoint called without `ADMIN_API_KEY` configured     |
| `500`  | `internal_error`       | Unexpected server error                                      |

---

## Authentication & Security

The platform supports multiple authentication schemes depending on the endpoint category:

1. **Admin Bearer Token**: Required for administrative operations under `/v1/admin/*`. Pass via header `Authorization: Bearer <ADMIN_API_KEY>`.
2. **Role-Based Access Control (RBAC)**: Required for `/v1/roles/*` endpoints. Pass user identifier via `X-User-Id: <user_id>`. Valid roles: `admin`, `operator`, `viewer`.
3. **Consumer API Keys**: External consumers authenticate with keys generated via `/v1/admin/api-keys`. Pass via `Authorization: Bearer <key>` or `X-API-Key: <key>`.
4. **IP Whitelisting**: Certain sensitive management endpoints (`/v1/admin/*`, `/v1/roles`, `/v1/webhooks`, `/v1/panels`, `/v1/metadata`, `/v1/email`, `/v1/scoring/formulas`, `/v1/chains`, `/v1/satellite-sources`) restrict access according to configured IP whitelist ranges when enabled.

---

## Rate Limiting

Endpoints enforce rate limiting per client IP or authenticated API key. Standard rate limit headers are included in responses:

- `RateLimit-Limit`: Maximum requests permitted per window
- `RateLimit-Remaining`: Remaining requests in current window
- `RateLimit-Reset`: Seconds until quota resets
- `Retry-After`: Included on `429 Too Many Requests` responses

Configurable environment variables (see [`.env.example`](./.env.example)):

- Public tier: `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`
- Admin tier: `RATE_LIMIT_ADMIN_WINDOW_MS`, `RATE_LIMIT_ADMIN_MAX`

---

## API Versioning

All current routes are mounted under the `/v1` prefix.
Legacy unversioned `/api/*` routes are deprecated and maintained for backward compatibility until 2027-01-01. Responses on `/api/*` include `Deprecation: true` and sunset warning headers.

---

## Route Groups Index

| Route Group            | Base Path                                | Auth Requirement            | Rate Limit Tier | Description                                                                                 |
| :--------------------- | :--------------------------------------- | :-------------------------- | :-------------- | :------------------------------------------------------------------------------------------ |
| **System & Health**    | `/health`, `/ready`, `/metrics`, `/docs` | Public                      | None / Default  | Liveness, readiness, Prometheus metrics, and OpenAPI/Swagger documentation                  |
| **Telemetry (IoT)**    | `/v1/iot`                                | Public / Consumer Key       | Public          | Simulated solar panel readings and satellite NDVI vegetation telemetry                      |
| **Projects**           | `/v1/projects`                           | Public / Consumer Key       | Public          | Paginated, filterable, and sortable project registry and detail                             |
| **Score History**      | `/v1/projects/:id/history`               | Public / Consumer Key       | Public          | Historical score logs and score direction trend evaluation                                  |
| **Aggregation**        | `/v1/projects/aggregate`                 | Public / Consumer Key       | Public          | Portfolio-level aggregate score calculations by category and region                         |
| **Portfolio**          | `/v1/portfolio`                          | Public / Consumer Key       | Public          | Investor deposit/withdrawal history, token shares, and valuation                            |
| **Metadata**           | `/v1/metadata`                           | IP Whitelist                | Admin           | Descriptive project metadata, geolocation, coordinates, and tags                            |
| **Panels Hardware**    | `/v1/panels`                             | IP Whitelist                | Admin           | Solar panel technical specifications and effective capacity calculation                     |
| **Dashboard**          | `/v1/dashboard`                          | Public / Consumer Key       | Public          | Portfolio summaries, top/bottom performers, score distributions, and CSV export             |
| **Comparison**         | `/v1/comparison`                         | Public / Consumer Key       | Public          | Side-by-side multi-project metric comparisons and ranked lists                              |
| **Benchmarking**       | `/v1/benchmarking`                       | Public / Consumer Key       | Public          | Standard/custom industry benchmark definitions, percentiles, and alerts                     |
| **Financial Modeling** | `/v1/financial`                          | Public / Consumer Key       | Public          | NPV, discounted payback, cost-benefit analysis, and parameter sensitivity                   |
| **Forecasting**        | `/v1/forecast`                           | Public / Consumer Key       | Public          | Time-series forecasting (ARIMA, smoothing, regression), weather adjustments, accuracy       |
| **Maintenance**        | `/v1/maintenance`                        | Public / Consumer Key       | Public          | Predictive failure modeling, work order tasks, scheduling calendar, maintenance logs        |
| **Anomaly Detection**  | `/v1/anomaly`                            | Public / Consumer Key       | Public          | Z-score anomaly detection on live IoT telemetry with configurable thresholds                |
| **Investor Reports**   | `/v1/investor`                           | Public / Consumer Key       | Public          | High-level executive summaries, ESG compliance reports, and custom PDF/JSON reports         |
| **Webhooks**           | `/v1/webhooks`                           | IP Whitelist                | Admin           | Webhook registration, HMAC secret configuration, and retry management                       |
| **Email Digests**      | `/v1/email`                              | IP Whitelist                | Admin           | Digest subscriptions, unsubscribe tokens, alert thresholds, and email templates             |
| **Multi-Chain**        | `/v1/chains`                             | IP Whitelist                | Admin           | Multi-blockchain network management and cross-chain score broadcasting                      |
| **Satellite Sources**  | `/v1/satellite-sources`                  | IP Whitelist                | Admin           | Satellite imagery provider priorities, adapter health checks, and fallback routing          |
| **Scoring Formulas**   | `/v1/scoring/formulas`                   | IP Whitelist                | Admin           | Custom impact scoring formulas, metric weighting, and A/B score preview                     |
| **Oracle & Admin**     | `/v1/admin`                              | Bearer Token / IP Whitelist | Admin           | Soroban smart contract oracle score updates and immutable audit logging                     |
| **Batch Operations**   | `/v1/admin/batch`                        | IP Whitelist                | Admin           | Asynchronous multi-project score update batch jobs with concurrency controls                |
| **Consumer API Keys**  | `/v1/admin/api-keys`                     | Bearer Token / IP Whitelist | Admin           | Generation, usage monitoring, scheduled rotation, and revocation of client API keys         |
| **RBAC Roles**         | `/v1/roles`                              | RBAC (`X-User-Id`)          | Admin           | User role assignment (`admin`, `operator`, `viewer`) and authorization policies             |
| **System Operations**  | `/v1/admin/*`, `/v1/traces`              | IP Whitelist / Admin        | Admin           | DB migrations, secret rotation, dynamic log levels, compression stats, OpenTelemetry traces |
| **GraphQL API**        | `/graphql`                               | Bearer / API Key            | Public / Admin  | Flexible GraphQL query and mutation endpoint with GraphiQL playground                       |
| **gRPC Service**       | `localhost:50051`                        | Metadata Auth               | RPC             | High-performance unary and streaming gRPC interface                                         |

---

## 1. System & Observability Endpoints

### `GET /health`

Liveness check and cron job execution status. Not rate limited.

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

### `GET /ready`

Readiness probe for load balancers and container orchestrators.

**Response `200` / `503`**

```json
{
  "status": "ready",
  "checks": {
    "database": "connected",
    "stellar_rpc": "available"
  }
}
```

### `GET /metrics`

Standard Prometheus format metrics endpoint for scraping.

### `GET /docs` & `GET /docs.json`

Interactive Swagger UI explorer (`/docs`) and raw OpenAPI 3.0.3 specification (`/docs.json`).

### `GET /v1/metrics`

Aggregated operational metrics dashboard (request counts, latency percentiles, error rates).

**Response `200`**

```json
{
  "requests_total": 14205,
  "error_rate_pct": 0.04,
  "avg_latency_ms": 18.2,
  "uptime_seconds": 3712
}
```

### `GET /v1/traces`

Exports distributed trace spans collected via OpenTelemetry.

| Param            | In    | Type   | Description                                      |
| :--------------- | :---- | :----- | :----------------------------------------------- |
| `correlation_id` | query | string | Optional correlation ID filter                   |
| `limit`          | query | int    | Max spans to return (default: `100`, max: `500`) |
| `since`          | query | int    | Unix ms timestamp filter                         |

**Response `200`**

```json
{
  "summary": {
    "total_spans": 240,
    "active_traces": 4
  },
  "spans": [
    {
      "trace_id": "9a12b48fe3...",
      "span_id": "7c88d12...",
      "name": "calculateNPV",
      "duration_ms": 1.4,
      "timestamp": 1718150400000
    }
  ]
}
```

---

## 2. IoT Telemetry Endpoints

### `GET /v1/iot/solar/:id`

Simulated solar panel telemetry for project `id`. Deterministic per `(project_id, clock_hour)`.

| Param | In   | Type | Rules                                          |
| :---- | :--- | :--- | :--------------------------------------------- |
| `id`  | path | int  | Positive integer (`>= 1`, `<= MAX_PROJECT_ID`) |

**Response `200`**

```json
{
  "power_output_kw": 742.15,
  "efficiency_pct": 74.21,
  "max_power_kw": 1000,
  "timestamp": 1718150400000
}
```

### `GET /v1/iot/satellite/:id`

Simulated satellite / vegetation index reading for project `id`.

**Response `200`**

```json
{
  "forest_density_pct": 68.44,
  "ndvi_score": 0.684,
  "timestamp": 1718150400000
}
```

---

## 3. Projects, History, & Aggregation

### `GET /v1/projects`

Paginated, filterable list of projects with latest scores and telemetry.

| Param        | In    | Type   | Rules                                                                                                                                | Default |
| :----------- | :---- | :----- | :----------------------------------------------------------------------------------------------------------------------------------- | :------ |
| `limit`      | query | int    | Integer `1..100`                                                                                                                     | `10`    |
| `cursor`     | query | int    | Non-negative integer offset                                                                                                          | `0`     |
| `min_score`  | query | number | Minimum credit quality score filter                                                                                                  | —       |
| `max_score`  | query | number | Maximum credit quality score filter                                                                                                  | —       |
| `min_date`   | query | number | Minimum timestamp (ms)                                                                                                               | —       |
| `max_date`   | query | number | Maximum timestamp (ms)                                                                                                               | —       |
| `sort_by`    | query | string | One of: `id`, `credit_quality`, `green_impact`, `power_output_kw`, `efficiency_pct`, `forest_density_pct`, `ndvi_score`, `timestamp` | `id`    |
| `sort_order` | query | string | `asc` or `desc`                                                                                                                      | `asc`   |

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
  "total": 50,
  "filtered_total": 50,
  "cursor": 10
}
```

### `GET /v1/projects/:id`

Detailed metrics and funding data for a specific project.

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

### `GET /v1/projects/:id/history`

Historical score logs for project `id`. Supports CSV export.

| Param    | In    | Type   | Description                |
| :------- | :---- | :----- | :------------------------- |
| `from`   | query | int    | Starting Unix ms timestamp |
| `to`     | query | int    | Ending Unix ms timestamp   |
| `format` | query | string | `json` (default) or `csv`  |

**Response `200` (JSON)**

```json
{
  "project_id": 1,
  "count": 2,
  "entries": [
    {
      "project_id": 1,
      "credit_quality": 74,
      "green_impact": 69,
      "recorded_at": 1718150400000
    }
  ]
}
```

### `GET /v1/projects/:id/history/trend`

Evaluates score direction (`improving`, `declining`, `stable`) over time.

**Response `200`**

```json
{
  "project_id": 1,
  "trend": "improving",
  "net_delta": 4.5,
  "data_points": 12
}
```

### `GET /v1/projects/aggregate`

Portfolio-level aggregated impact and credit quality metrics across projects.

| Param      | In    | Type   | Rules                                                     |
| :--------- | :---- | :----- | :-------------------------------------------------------- |
| `limit`    | query | int    | Number of projects to aggregate (`1..100`, default: `20`) |
| `cursor`   | query | int    | Offset (default: `0`)                                     |
| `category` | query | string | Optional filter: `solar`, `forest`, `wind`                |
| `region`   | query | string | Optional filter: `north`, `south`, `east`, `west`         |

**Response `200`**

```json
{
  "project_count": 20,
  "avg_credit_quality": 78.4,
  "avg_green_impact": 72.1,
  "total_power_output_kw": 14200.5,
  "cursor": 20,
  "limit": 20
}
```

---

## 4. Portfolio & Position

### `GET /v1/portfolio/:address`

Indexed deposit/withdrawal transaction history, share count, and position value for a Stellar account address.

**Response `200`**

```json
{
  "address": "GBBD...24KL",
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

---

## 5. Project Metadata & Panel Configurations

### `GET /v1/metadata` & `GET /v1/metadata/:id`

Retrieves project descriptive metadata (name, description, location, geographic coordinates, tags, and attached panel specs).

**Response `200`**

```json
{
  "project_id": 1,
  "name": "Sahara Sol I",
  "description": "High-efficiency utility-scale solar farm",
  "location": "North Africa",
  "coordinates": { "latitude": 27.12, "longitude": 13.18 },
  "tags": ["utility", "clean-energy"],
  "panel_config": {
    "project_id": 1,
    "model": "SunPower Maxeon 6",
    "manufacturer": "SunPower",
    "panel_count": 2500,
    "wattage_per_panel": 400,
    "effective_capacity_kw": 1000
  }
}
```

### `PUT /v1/metadata/:id` & `PATCH /v1/metadata/:id`

Creates, replaces, or updates project metadata.

**Request Body**

```json
{
  "name": "Sahara Sol I",
  "description": "Expanded 1.2MW capacity solar array",
  "location": "North Africa",
  "coordinates": { "latitude": 27.12, "longitude": 13.18 },
  "tags": ["solar", "expansion"]
}
```

### `GET /v1/panels` & `GET /v1/panels/:id`

Retrieves solar panel hardware specs and calculates effective capacity (`panel_count * wattage_per_panel / 1000`).

### `PUT /v1/panels/:id` & `PATCH /v1/panels/:id`

Configures solar panel specifications for project `id`.

**Request Body**

```json
{
  "model": "SunPower Maxeon 6",
  "manufacturer": "SunPower",
  "panel_count": 2500,
  "wattage_per_panel": 400,
  "tilt_angle": 25,
  "azimuth": 180,
  "panel_type": "monocrystalline",
  "installation_date": "2024-01-15"
}
```

---

## 6. Analytics Dashboard

### `GET /v1/dashboard/summary`

High-level overview of total projects, average credit scores, average green impact, and total power generation.

**Response `200`**

```json
{
  "total_projects": 50,
  "avg_credit_quality": 76.5,
  "avg_green_impact": 71.2,
  "total_power_output_kw": 36500.8
}
```

### `GET /v1/dashboard/performers`

Ranks top and bottom performing projects across the portfolio.

| Param   | In    | Type | Rules           | Default |
| :------ | :---- | :--- | :-------------- | :------ |
| `limit` | query | int  | Integer `1..50` | `5`     |

**Response `200`**

```json
{
  "top": [{ "id": 12, "credit_quality": 98, "green_impact": 95 }],
  "bottom": [{ "id": 4, "credit_quality": 38, "green_impact": 42 }]
}
```

### `GET /v1/dashboard/distribution`

Generates score distribution histogram data for charts.

| Param    | In    | Type   | Rules                                 | Default          |
| :------- | :---- | :----- | :------------------------------------ | :--------------- |
| `field`  | query | string | `credit_quality` or `green_impact`    | `credit_quality` |
| `bucket` | query | int    | Number of histogram buckets (`1..50`) | `10`             |

### `GET /v1/dashboard/timeseries/:id`

Retrieves historical score data points for a specific project. Supports `?from=` and `?to=` query filters.

### `GET /v1/dashboard/export`

Exports the entire portfolio score database in CSV format (`Content-Type: text/csv`).

---

## 7. Project Comparison & Ranking

### `GET /v1/comparison`

Compares up to 20 projects side by side across environmental and financial metrics.

| Param | In    | Type   | Rules                                                         |
| :---- | :---- | :----- | :------------------------------------------------------------ |
| `ids` | query | string | Comma-separated list of positive integer project IDs (max 20) |

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
      "ndvi_score": 0.684
    },
    {
      "id": 2,
      "credit_quality": 88,
      "green_impact": 82,
      "power_output_kw": 890.0,
      "efficiency_pct": 89.0,
      "forest_density_pct": 74.1,
      "ndvi_score": 0.741
    }
  ]
}
```

### `GET /v1/comparison/metrics`

Lists all supported comparison metric keys (`credit_quality`, `green_impact`, `power_output_kw`, `efficiency_pct`, `forest_density_pct`, `ndvi_score`, `combined_score`).

### `GET /v1/comparison/ranking`

Ranks a set of projects according to chosen criteria.

| Param      | In    | Type   | Rules                       | Default          |
| :--------- | :---- | :----- | :-------------------------- | :--------------- |
| `ids`      | query | string | Comma-separated project IDs | Required         |
| `criteria` | query | string | Any valid comparison metric | `combined_score` |

### `GET /v1/comparison/export` & `GET /v1/comparison/ranking/export`

Exports project comparison or ranked analysis to CSV format.

---

## 8. Industry Benchmarking

### `GET /v1/benchmarking/benchmarks` & `GET /v1/benchmarking/benchmarks/:id`

Lists standard and custom benchmark definitions with evaluation thresholds (`poor`, `fair`, `good`, `excellent`).

**Response `200`**

```json
{
  "benchmarks": [
    {
      "id": "credit_quality",
      "name": "Industry Credit Quality",
      "description": "Standardized financial creditworthiness",
      "metric": "credit_quality",
      "thresholds": { "poor": 40, "fair": 60, "good": 80, "excellent": 90 },
      "source": "Standard & Poor's ESG"
    }
  ]
}
```

### `POST /v1/benchmarking/benchmarks`

Registers a new custom benchmark definition.

**Request Body**

```json
{
  "id": "custom_efficiency",
  "name": "High-Efficiency Solar Benchmark",
  "description": "Benchmark for bifacial tier-1 solar assets",
  "metric": "efficiency_pct",
  "thresholds": { "poor": 50, "fair": 70, "good": 85, "excellent": 95 },
  "source": "NREL 2026 Guidelines"
}
```

### `GET /v1/benchmarking/:id`

Evaluates project `id` against all registered industry benchmarks.

### `GET /v1/benchmarking/:id/percentiles`

Calculates project percentile ranking against all projects in the registry.

| Param    | In    | Type   | Rules              | Default          |
| :------- | :---- | :----- | :----------------- | :--------------- |
| `metric` | query | string | Metric key to rank | `combined_score` |

### `GET /v1/benchmarking/:id/alerts`

Returns active alerts for project metrics falling below benchmark thresholds.

### `GET /v1/benchmarking/:id/trend`

Evaluates project performance trajectory relative to a benchmark over time.

---

## 9. Financial Analysis & Modeling

### `GET /v1/financial/cost-benefit/:id`

Detailed cost-benefit analysis breakdown over the project lifetime.

| Param                       | In    | Type   | Description                                     |
| :-------------------------- | :---- | :----- | :---------------------------------------------- |
| `installation_cost`         | query | number | Optional override for total capital expenditure |
| `annual_maintenance_cost`   | query | number | Optional override for annual O&M                |
| `electricity_price_per_kwh` | query | number | Price per kWh generated                         |
| `discount_rate`             | query | number | Annual discount rate (e.g. `0.06` for 6%)       |
| `project_lifetime_years`    | query | number | Project lifespan (default: `25`)                |

**Response `200`**

```json
{
  "project_id": 1,
  "installation_cost": 250000,
  "total_revenue": 680000,
  "total_maintenance_cost": 75000,
  "net_benefit": 355000,
  "roi_pct": 142.0,
  "annual_cash_flows": [
    { "year": 1, "revenue": 27200, "maintenance_cost": 3000, "net_cash_flow": 24200 }
  ]
}
```

### `GET /v1/financial/payback/:id`

Computes simple and discounted payback periods in years.

**Response `200`**

```json
{
  "project_id": 1,
  "payback_years": 7.4,
  "discounted_payback_years": 9.2,
  "reaches_payback": true
}
```

### `GET /v1/financial/npv/:id`

Calculates Net Present Value (NPV) based on discounted future cash flows.

**Response `200`**

```json
{
  "project_id": 1,
  "npv": 118450.25,
  "discount_rate": 0.06,
  "discounted_cash_flows": [{ "year": 1, "discounted_cash_flow": 22830.19 }]
}
```

### `GET /v1/financial/sensitivity/:id`

Performs sensitivity analysis evaluating how NPV and ROI respond to changes in discount rates, electricity prices, and degradation rates.

### `GET /v1/financial/roi-comparison`

Compares ROI, NPV, and payback across multiple projects (`?ids=1,2,3`).

---

## 10. Forecasting & Predictive Modeling

### `GET /v1/forecast/:id`

Generates time-series forecasts for future power generation or efficiency.

| Param           | In    | Type   | Rules                                                                              | Default                 |
| :-------------- | :---- | :----- | :--------------------------------------------------------------------------------- | :---------------------- |
| `horizon`       | query | int    | Hours ahead to forecast (`1..8760`)                                                | `24`                    |
| `field`         | query | string | `power_output_kw` or `efficiency_pct`                                              | `power_output_kw`       |
| `method`        | query | string | `exponential_smoothing`, `linear_regression`, `moving_average`, `arima_simplified` | `exponential_smoothing` |
| `history_hours` | query | int    | Historical sample window (`4..8760`)                                               | `168`                   |
| `format`        | query | string | `json` or `csv`                                                                    | `json`                  |

**Response `200`**

```json
{
  "project_id": 1,
  "field": "power_output_kw",
  "method": "exponential_smoothing",
  "predictions": [
    {
      "hour_offset": 1,
      "predicted_value": 745.2,
      "confidence_lower": 710.0,
      "confidence_upper": 780.4
    }
  ]
}
```

### `GET /v1/forecast/weather-adjusted/:id`

Forecasts power generation factoring in diurnal solar irradiance and simulated cloud cover patterns.

### `GET /v1/forecast/seasonal/:id`

Decomposes performance into seasonal, diurnal, and periodic cycles.

### `GET /v1/forecast/accuracy/:id`

Backtests forecasting models against historical project telemetry and reports accuracy metrics (`mae`, `rmse`, `mape`).

### `GET /v1/forecast/methods/available`

Returns list of available forecasting model identifiers.

---

## 11. Predictive Maintenance & Work Orders

### `GET /v1/maintenance/:id/trend`

Analyzes efficiency degradation trend and rate of loss over time.

### `GET /v1/maintenance/:id/failure-prediction`

Predictive modeling identifying hardware failure risks, estimated hours/days to critical threshold, severity, and confidence score. Supports CSV export.

**Response `200`**

```json
{
  "project_id": 1,
  "current_efficiency": 74.21,
  "critical_threshold": 50.0,
  "estimated_hours_to_threshold": 1420,
  "estimated_days_to_threshold": 59.1,
  "severity": "medium",
  "confidence": 0.88,
  "panel_type": "monocrystalline"
}
```

### `GET /v1/maintenance/:id/recommendation`

Actionable maintenance recommendations (e.g. panel cleaning, inverter diagnostics, string inspection) based on telemetry patterns.

### `GET /v1/maintenance/:id/schedule`

Optimal scheduled maintenance calendar with recommended target dates and estimated costs.

### `GET /v1/maintenance/:id/full-report`

Consolidated health check including efficiency trends, failure predictions, recommendations, and maintenance schedules.

### `POST /v1/maintenance/tasks`

Creates a maintenance task / work order.

**Request Body**

```json
{
  "project_id": 1,
  "title": "Quarterly Inverter Inspection",
  "description": "Thermal scan of inverter modules and terminal connections",
  "action_type": "inspection",
  "priority": "high",
  "scheduled_date": "2026-09-15",
  "assigned_to": "technician_1",
  "estimated_cost": 450
}
```

### `GET /v1/maintenance/tasks`

Lists work orders with query filters: `project_id`, `status` (`pending`, `in_progress`, `completed`, `cancelled`), `priority`, `from_date`, `to_date`, `format` (`json` or `csv`).

### `POST /v1/maintenance/tasks/generate/:id`

Auto-generates recommended work orders for project `id` from predictive schedule analysis.

### `GET /v1/maintenance/tasks/:taskId` & `PATCH /v1/maintenance/tasks/:taskId`

Retrieves or partially modifies a specific maintenance task.

### `POST /v1/maintenance/tasks/:taskId/complete`

Marks a task completed and records actual costs and before/after efficiency delta.

**Request Body**

```json
{
  "actual_cost": 420.0,
  "notes": "Replaced faulty connector on string 4",
  "efficiency_before": 72.1,
  "efficiency_after": 78.4
}
```

### `DELETE /v1/maintenance/tasks/:taskId`

Deletes a maintenance task.

### `GET /v1/maintenance/calendar` & `GET /v1/maintenance/calendar/range`

Calendar views (`daily`, `weekly`, `monthly`) or custom date ranges (`?from=YYYY-MM-DD&to=YYYY-MM-DD`) of scheduled maintenance.

### `GET /v1/maintenance/history/:id` & `POST /v1/maintenance/history/:id`

Retrieves or manually logs a past maintenance intervention.

### `GET /v1/maintenance/stats`

Maintenance KPIs: completed task count, total maintenance spend, average resolution time, and efficiency gains.

---

## 12. Anomaly Detection

### `GET /v1/anomaly/:id`

Runs statistical z-score and moving average anomaly detection on project telemetry.

| Param         | In    | Type   | Rules                               |
| :------------ | :---- | :----- | :---------------------------------- |
| `sensitivity` | query | number | Optional z-score threshold override |
| `window`      | query | number | Moving baseline window size         |

**Response `200`**

```json
{
  "project_id": 1,
  "is_anomaly": true,
  "anomaly_score": 3.42,
  "flagged_metrics": ["efficiency_pct"],
  "details": {
    "efficiency_pct": { "value": 41.2, "expected": 74.0, "z_score": -3.42 }
  }
}
```

### `GET /v1/anomaly` & `PUT /v1/anomaly/config`

Retrieves or updates anomaly detection configuration (`sensitivityZScore`, `trendWindowSize`, `trendDeviationPct`, `minBaseline`).

### `DELETE /v1/anomaly/history/:id?`

Clears baseline history cache for a specific project or all projects.

---

## 13. Investor Reporting

### `GET /v1/investor/dashboard`

Portfolio-wide aggregated dashboard summary and recent audit activities for investor portals.

**Response `200`**

```json
{
  "portfolio_summary": {
    "total_projects": 2,
    "total_power_output_kw": 1150,
    "avg_credit_quality": 85,
    "avg_green_impact": 75,
    "total_portfolio_value": 950000,
    "total_carbon_offsets_tonnes": 4312.5
  },
  "recent_activities": [
    {
      "id": 1,
      "project_id": 1,
      "credit_quality": 85,
      "green_impact": 75,
      "tx_hash": "tx123",
      "triggered_by": "api",
      "timestamp": 1718150400000
    }
  ]
}
```

### `GET /v1/investor/performance-report`

Provides actual vs expected performance ratios and operational status (`Optimal`, `Underperforming`, `Critical`) for all portfolio assets.

### `GET /v1/investor/financial-summary`

Aggregates financial KPIs (total installation cost, total NPV, average payback period, average ROI).

### `GET /v1/investor/compliance-report`

ESG compliance scoring, verified carbon credits issued, and immutable audit logs.

### `POST /v1/investor/custom-report`

Generates customized reports tailored by project ID list and report sections.

**Request Body**

```json
{
  "project_ids": [1, 2],
  "sections": ["performance", "scores", "financials", "compliance"]
}
```

---

## 14. Webhooks & Event Subscriptions

### `POST /v1/webhooks`

Registers an external HTTP endpoint to receive real-time event notifications (e.g. score updates, threshold alerts).

**Request Body**

```json
{
  "url": "https://api.external.com/webhooks/heliobond",
  "secret": "super_secret_signing_key_at_least_16_chars",
  "max_retries": 3,
  "retry_delay_ms": 2000
}
```

**Response `201`**

```json
{
  "id": "wh_9f2a48b1",
  "url": "https://api.external.com/webhooks/heliobond",
  "max_retries": 3,
  "retry_delay_ms": 2000,
  "created_at": 1718150400000
}
```

### `GET /v1/webhooks` & `GET /v1/webhooks/:id`

Lists registered webhooks or retrieves details for a single webhook (secrets are omitted).

### `DELETE /v1/webhooks/:id`

Unregisters and deletes a webhook subscription.

---

## 15. Email Digests & Notifications

### `POST /v1/email/subscribe`

Subscribes an email address to recurring summary digests.

**Request Body**

```json
{
  "email": "investor@example.com",
  "frequency": "weekly"
}
```

### `GET /v1/email/unsubscribe`

One-click unsubscribe endpoint (`?token=<unsubscribe_token>`).

### `GET /v1/email/subscribers`

Lists current subscribers with optional `?frequency=daily|weekly` filter.

### `GET /v1/email/thresholds` & `PUT /v1/email/thresholds`

Retrieves or updates alerting thresholds for automatic email notifications.

### `GET /v1/email/templates` & `PUT /v1/email/templates`

Manages markdown/HTML templates for digest emails (`name`, `subject`, `body`).

### `POST /v1/email/digest`

Triggers an on-demand digest dispatch to subscribers.

---

## 16. Multi-Chain Integrations

### `GET /v1/chains` & `GET /v1/chains/:id`

Lists configured blockchains (Stellar, Polygon, Ethereum, etc.) and active RPC status.

### `PATCH /v1/chains/:id`

Updates configuration for a specific chain network (`enabled`, `rpcUrl`, `contractAddress`, `name`).

### `POST /v1/chains/broadcast/:projectId`

Broadcasts computed project impact scores across one or all enabled blockchain networks.

**Request Body**

```json
{
  "chains": ["stellar", "polygon"]
}
```

---

## 17. Satellite Data Sources

### `GET /v1/satellite-sources`

Lists configured satellite data providers (e.g. Sentinel-2, Landsat-9, MODIS, Planet) with priority and health status.

### `GET /v1/satellite-sources/health`

Health check status and consecutive failure counts per data source provider.

### `PATCH /v1/satellite-sources/:name`

Enables/disables a source or alters its priority in the failover cascade (`{ "enabled": true, "priority": 1 }`).

### `POST /v1/satellite-sources`

Registers a custom external satellite data adapter endpoint (`name`, `priority`, `fetchUrl`).

### `GET /v1/satellite-sources/fetch/:projectId`

Fetches satellite NDVI data from the highest-priority available source with automatic fallback failover.

---

## 18. Custom Scoring Formulas & A/B Testing

### `GET /v1/scoring/formulas`

Lists all scoring formula definitions and identifies the currently active formula ID.

### `POST /v1/scoring/formulas`

Creates a custom formula assigning weights to telemetry metrics.

**Request Body**

```json
{
  "id": "solar_heavy_v2",
  "name": "Solar Focused Impact Formula",
  "description": "Increases weighting of solar efficiency over vegetation",
  "weights": {
    "efficiency_pct": 0.6,
    "power_output_kw": 0.2,
    "ndvi_score": 0.2
  }
}
```

### `GET /v1/scoring/formulas/:id` & `DELETE /v1/scoring/formulas/:id`

Retrieves or deletes a custom scoring formula definition.

### `POST /v1/scoring/formulas/:id/activate`

Activates a custom formula platform-wide for subsequent score computations.

### `POST /v1/scoring/formulas/validate`

Validates weight distribution and sum normalization without saving.

### `GET /v1/scoring/formulas/:id/preview/:projectId`

Simulates and previews score changes for a project using the custom formula vs the default formula (A/B testing).

---

## 19. Administration & System Management

### `POST /v1/admin/update-scores`

Computes and submits `update_impact_score` transactions to the Soroban smart contract oracle.

**Headers**

| Header          | Required                       | Value                    |
| :-------------- | :----------------------------- | :----------------------- |
| `Authorization` | Yes (when `ADMIN_API_KEY` set) | `Bearer <ADMIN_API_KEY>` |

**Request Body (optional)**

```json
{
  "project_ids": [1, 2, 3]
}
```

**Response `200`**

```json
{
  "updated": 2,
  "results": [
    { "project_id": 1, "tx_hash": "abc123...", "credit_quality": 74, "green_impact": 69 }
  ],
  "errors": [],
  "skipped": []
}
```

### `GET /v1/admin/audit`

Immutable audit log of all on-chain score updates with query filters (`?project_id=`, `?from=`, `?to=`, `?format=json|csv`).

### `POST /v1/admin/batch/score-update`

Starts an asynchronous background batch score update job with concurrency controls.

**Request Body**

```json
{
  "project_ids": [1, 2, 3, 4, 5],
  "concurrency": 3
}
```

**Response `202 Accepted`**

```json
{
  "batch_id": "job_9a8f21c4",
  "status": "running",
  "total": 5,
  "concurrency": 3
}
```

### `GET /v1/admin/batch/:batchId/status`

Polls progress, completion status, results, and errors for a batch job.

### `POST /v1/admin/api-keys`

Generates a new consumer API key with rate limits and rotation intervals.

**Request Body**

```json
{
  "consumer_name": "Acme Partner Service",
  "rate_limit": 100,
  "rotation_interval_days": 90
}
```

### `GET /v1/admin/api-keys`, `POST /v1/admin/api-keys/:id/rotate`, `DELETE /v1/admin/api-keys/:id`, `GET /v1/admin/api-keys/:id/usage`

Full lifecycle management for consumer API credentials.

### `GET /v1/roles`, `POST /v1/roles`, `DELETE /v1/roles/:userId`

Role-Based Access Control (RBAC) user assignment (`admin`, `operator`, `viewer`).

### `GET /v1/admin/secrets/status`

Checks encryption secret rotation status and schedule.

### `GET /v1/admin/migrations`, `POST /v1/admin/migrations/up`, `POST /v1/admin/migrations/rollback`

Database migration status and execution controls.

### `GET /v1/admin/logging/level` & `PUT /v1/admin/logging/level`

Inspects or dynamically updates the runtime logger level (`debug`, `info`, `warn`, `error`).

### `GET /v1/admin/compression`

Reports response compression efficiency and byte savings.

### `GET /v1/admin/flags`, `GET /v1/admin/flags/:name`, `POST /v1/admin/flags/load`, `POST /v1/admin/flags/merge`, `GET /v1/admin/flags/analytics`

Feature flag management and evaluation context analytics.

---

## 20. GraphQL API

- **HTTP Endpoint**: `/graphql` (POST requests)
- **GraphiQL Playground**: `/graphql-playground` (GET request in browser)

### Example Query

```graphql
query GetProjectsWithSolar {
  projects(limit: 5) {
    id
    credit_quality
    green_impact
    solar {
      power_output_kw
      efficiency_pct
      max_power_kw
    }
    financials {
      npv
      roi_pct
      payback_period_years
    }
  }
}
```

### Example Mutation (Requires Admin Auth)

```graphql
mutation UpdateProjectScore {
  updateProjectScores(id: "1", creditQuality: 90, greenImpact: 85) {
    id
    credit_quality
    green_impact
  }
}
```

---

## 21. gRPC Service

High-performance gRPC service listening on port `50051`. Authenticates callers via gRPC metadata headers (`authorization` or `x-api-key`).

### Service Definition

```protobuf
syntax = "proto3";

package heliobond;

service HeliobondService {
  rpc GetProjectScore(ProjectRequest) returns (ProjectResponse);
  rpc StreamProjectScores(StreamRequest) returns (stream ProjectResponse);
  rpc ChatProjectScores(stream ProjectRequest) returns (stream ProjectResponse);
}

message ProjectRequest {
  int32 project_id = 1;
}

message StreamRequest {
  repeated int32 project_ids = 1;
}

message ProjectResponse {
  int32 project_id = 1;
  double credit_quality = 2;
  double green_impact = 3;
  double power_output_kw = 4;
  double efficiency_pct = 5;
  int64 timestamp = 6;
}
```
