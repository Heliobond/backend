# ── Build stage ──────────────────────────────────────────────────────────────
# bun.lock is the canonical lockfile (CI installs with `bun install
# --frozen-lockfile`); there is no package-lock.json, so `npm ci` cannot work.
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Skip the husky prepare hook — it needs a .git checkout that images lack.
ENV HUSKY=0

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

RUN bun run build

# ── Production dependency stage ─────────────────────────────────────────────
# Prod-only install for the Node runtime image below.
FROM oven/bun:1-alpine AS prod-deps

WORKDIR /app

ENV HUSKY=0

# --ignore-scripts: the `prepare` hook runs `husky`, which is a devDependency
# and therefore absent from a --production install.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts && bun pm cache rm

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production

ENV NODE_ENV=production

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
# Cap the V8 old-space heap below the 512MB container memory limit (#225).
# The headroom covers the Node binary, native buffers and the RPC client, so a
# runaway polling loop hits an OOM inside Node — with a JS stack trace — rather
# than being SIGKILLed by the kernel with no diagnostics.
ENV NODE_OPTIONS="--max-old-space-size=384"

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./

COPY --from=builder /app/dist ./dist

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
