# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:26-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:26-alpine AS production

ENV NODE_ENV=production

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
# Cap the V8 old-space heap below the 512MB container memory limit (#225).
# The headroom covers the Node binary, native buffers and the RPC client, so a
# runaway polling loop hits an OOM inside Node — with a JS stack trace — rather
# than being SIGKILLed by the kernel with no diagnostics.
ENV NODE_OPTIONS="--max-old-space-size=384"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
