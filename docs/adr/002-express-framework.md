# ADR-002: Use Express 5 as the HTTP Framework

## Status

Accepted

## Context

The backend requires an HTTP framework to serve REST APIs, middleware, and static assets. The team evaluated options:

1. **Express 5** — Mature, widely-adopted Node.js framework with async error handling
2. **Fastify** — High-performance alternative with schema-based validation
3. **Koa** — Lightweight middleware-focused framework
4. **Hono** — Modern, edge-ready framework with multi-runtime support
5. **Node.js http module** — Raw HTTP server without framework abstractions

Key requirements:
- Middleware support (CORS, rate limiting, auth, logging)
- JSON request/response handling
- Route parameter parsing
- WebSocket support (via separate `ws` library)
- Swagger/OpenAPI integration
- Mature ecosystem with extensive middleware availability

## Decision

Use Express 5 as the HTTP framework.

### Rationale

- **Proven reliability**: Express is the most battle-tested Node.js HTTP framework
- **Middleware ecosystem**: Largest collection of middleware (cors, rate-limit, swagger-ui-express)
- **Team familiarity**: Most Node.js developers have Express experience
- **Async error handling**: Express 5 natively supports async route handlers without wrappers
- **WebSocket compatibility**: Works seamlessly with the `ws` library for real-time features
- **Low learning curve**: Minimal onboarding overhead for new contributors

## Consequences

### Positive

- Mature, stable framework with extensive documentation
- Rich middleware ecosystem covers all our needs
- Express 5's native async support eliminates try/catch wrappers in routes
- Easy integration with existing tooling (Swagger UI, CORS, rate limiting)

### Negative

- Slightly lower raw performance than Fastify for high-throughput scenarios
- No built-in schema validation (handled by manual validation or separate libraries)

### Neutral

- Route organization uses Express Router for modular API structure
- Legacy `/api` paths maintained for backward compatibility alongside `/v1`
