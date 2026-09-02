# Deployment

How the backend gets built, what it is allowed to consume at runtime, and how it
reaches staging and production.

Database connections to staging and production use TLS with certificate
validation. The CA certificate is supplied via the `DATABASE_CA` environment
variable; `rejectUnauthorized` is never disabled.

## Resource requirements

The service is a single Node process: an Express API plus a `node-cron` polling
loop that talks to Stellar RPC. Both the polling loop and the RPC client hold
buffers that grow with the number of tracked projects, so the container declares
hard limits. Without them a leak or a runaway loop can consume the whole host
and take neighbouring services down with it.

| Resource     | Limit    | Reservation | Where it is set                    |
| ------------ | -------- | ----------- | ---------------------------------- |
| Memory       | 512 MB   | 256 MB      | `docker-compose.yml`               |
| CPU          | 0.5 core | 0.25 core   | `docker-compose.yml`               |
| V8 heap      | 384 MB   | n/a         | `NODE_OPTIONS` in the `Dockerfile` |
| Redis memory | 256 MB   | 64 MB       | `docker-compose.yml`               |
| Redis CPU    | 0.25     | 0.1         | `docker-compose.yml`               |

### Why the heap ceiling is lower than the memory limit

`--max-old-space-size=384` sits ~128 MB below the 512 MB container limit. That
gap covers the Node binary, the C++ heap, native buffers and thread stacks —
things V8 does not count against old space.

The point is which failure you get. If V8 is allowed to grow past the container
limit, the kernel OOM killer sends SIGKILL and you get nothing: no stack, no log
line, just a restart. With the ceiling set below the limit, V8 throws
`JavaScript heap out of memory` first and you get a stack trace pointing at what
was allocating.

Redis is capped independently with `--maxmemory 192mb` and an `allkeys-lru`
eviction policy, so it evicts rather than growing into its own container limit.

### Running with the limits

`deploy.resources` is honoured by Compose v2 outside swarm mode, so the normal
path already applies them:

```bash
docker compose up -d
```

For a bare `docker run`, pass them explicitly:

```bash
docker run --memory=512m --cpus=0.5 \
  -e NODE_OPTIONS=--max-old-space-size=384 \
  -p 3000:3000 --env-file .env \
  ghcr.io/<owner>/backend:latest
```

Verify what the running container actually got:

```bash
docker stats --no-stream
docker inspect <container> --format '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}'
```

### Tuning

Raise the limits together, keeping roughly the same gap. Doubling memory to
1 GB means `--max-old-space-size=768`. Raising only the container limit wastes
the extra headroom, since V8 will not grow into it. Raising only the heap
ceiling reintroduces the SIGKILL failure mode.

If the process is being killed at 512 MB under normal load, look at the polling
loop's per-cycle allocations before increasing the ceiling.

## CI/CD pipeline

Three workflows, each with a distinct job:

| Workflow      | Trigger                           | Does                          |
| ------------- | --------------------------------- | ----------------------------- |
| `ci.yml`      | push to `main`, PRs to `main`     | build, test, dependency audit |
| `release.yml` | push to `main`, manual dispatch   | version, changelog, git tag   |
| `deploy.yml`  | push to `main`, release, tag `v*` | build image, push, deploy     |

### What triggers which environment

| Event                                  | Environment |
| -------------------------------------- | ----------- |
| Push to `main` (including a merged PR) | staging     |
| Published GitHub release               | production  |
| Tag matching `v*`                      | production  |
| `repository_dispatch` type `deploy`    | production  |
| Manual `workflow_dispatch`             | your choice |

`release.yml` already fires a `repository_dispatch` with `event_type=deploy`
after a manual release, so a manual release reaches production without a second
step.

### Image registry

Images go to GitHub Container Registry at
`ghcr.io/<owner>/backend`, authenticated with the built-in `GITHUB_TOKEN` — no
extra registry secret needed. Tags produced per build:

- `main` — the branch build
- `sha-<full-sha>` — immutable, one per commit
- `1.2.3`, `1.2` — on semver tags
- `latest` — default branch only

Deployments reference the image **by digest**, not by tag, so the environment
runs exactly the image the workflow built even if a tag is later moved.

### Deployment status in PRs

`deploy.yml` opens a GitHub Deployment before rolling out and closes it with
`success` or `failure` afterwards. Because the deployment is attached to the
merge commit, the result appears on the merged PR and in the repository's
Environments view, with a link back to the workflow run.

### Configuration

| Secret / variable | Required | Purpose                              |
| ----------------- | -------- | ------------------------------------ |
| `GITHUB_TOKEN`    | built-in | GHCR push and deployment status      |
| `DEPLOY_HOOK_URL` | yes      | Endpoint told to pull the new digest |
| `DATABASE_CA`     | yes      | CA certificate for Postgres TLS; required in staging and production |

`DEPLOY_HOOK_URL` is whatever the hosting platform exposes — a Render or Railway
deploy hook, a Fly webhook, or a self-hosted endpoint. It receives:

```json
{ "image": "ghcr.io/<owner>/backend@sha256:...", "environment": "staging" }
```

Set it per environment under **Settings → Environments → staging / production**
so staging and production can point at different hosts.

If `DEPLOY_HOOK_URL` is unset the workflow still builds and publishes the image,
logs a warning, and marks the deployment successful — useful before hosting is
wired up. Set it once the target exists, or the pipeline will silently stop
short of an actual rollout.

### Rollback

Deployments are pinned to digests, so rolling back means pointing the hook at an
earlier one:

```bash
docker buildx imagetools inspect ghcr.io/<owner>/backend:latest
gh workflow run deploy.yml -f environment=production
```

To redeploy a specific past commit, re-run that commit's `deploy.yml` run from
the Actions tab.

## Related

- [SETUP.md](SETUP.md) — local development setup
- `Dockerfile` — build stages and the heap ceiling
- `docker-compose.yml` — resource limits and service wiring
