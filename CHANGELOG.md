# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Health check endpoint with uptime and last cron run status
- IoT simulation endpoints for solar panel and satellite readings
- Soroban ProjectRegistry contract integration for impact score updates
- Admin endpoint for batch score updates with Bearer token authentication
- Hourly cron job for automatic on-chain score updates
- GraphQL API layer via graphql-http
- gRPC service layer with proto definitions
- Rate limiting for public and admin endpoints
- Swagger/OpenAPI documentation via swagger-ui-express
- Load testing suite with k6 (smoke, average, stress, spike, GraphQL scenarios)
- Jest test suite with ts-jest and Supertest
- ESLint + Prettier code quality tooling
- Husky pre-commit hooks with lint-staged
- CI pipeline with GitHub Actions (build + test)
- CORS configuration for frontend integration
- WebSocket support with token-based authentication
- Input sanitization and security headers

### Changed

- Upgraded to Express 5
- Migrated to TypeScript strict mode

### Security

- Bearer token authentication for admin endpoints
- Rate limiting to prevent abuse
- Security policy documentation
