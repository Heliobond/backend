export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Heliobond Backend API",
    version: "1.0.0",
    description:
      "REST API for the Heliobond impact-investment platform. " +
      "All endpoints are available under `/v1`. The unversioned paths " +
      "(`/api/...`) are deprecated and will be removed after 2027-01-01.",
  },
  servers: [
    { url: "/v1", description: "Current (v1)" },
    { url: "/api", description: "Deprecated — use /v1" },
  ],
  components: {
    securitySchemes: {
      UserId: {
        type: "apiKey" as const,
        in: "header",
        name: "X-User-Id",
        description: "Required for admin and role-management endpoints.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
        },
      },
      Project: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          credit_quality: { type: "number" },
          green_impact: { type: "number" },
        },
      },
      ScoreHistory: {
        type: "object",
        properties: {
          project_id: { type: "integer" },
          credit_quality: { type: "number" },
          green_impact: { type: "number" },
          recorded_at: { type: "integer", description: "Unix ms timestamp" },
        },
      },
      Trend: {
        type: "object",
        properties: {
          trend: { type: "string", enum: ["improving", "declining", "stable"] },
          net_delta: { type: "number" },
          data_points: { type: "integer" },
        },
      },
      BatchJob: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["pending", "running", "done", "failed"] },
          total: { type: "integer" },
          completed: { type: "integer" },
          failed: { type: "integer" },
          started_at: { type: "integer" },
          finished_at: { type: "integer", nullable: true },
        },
      },
      Role: {
        type: "object",
        properties: {
          userId: { type: "string" },
          role: { type: "string", enum: ["admin", "operator", "viewer"] },
        },
      },
      Webhook: {
        type: "object",
        properties: {
          id: { type: "string" },
          url: { type: "string" },
          secret: { type: "string" },
        },
      },
    },
  },
  paths: {
    "/iot/solar/{projectId}": {
      get: {
        summary: "Get solar data for a project",
        tags: ["IoT"],
        parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          200: { description: "Solar metrics" },
        },
      },
    },
    "/iot/satellite/{projectId}": {
      get: {
        summary: "Get satellite data for a project",
        tags: ["IoT"],
        parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          200: { description: "Satellite metrics" },
        },
      },
    },
    "/projects": {
      get: {
        summary: "List all projects",
        tags: ["Projects"],
        responses: {
          200: { description: "Array of projects" },
        },
      },
    },
    "/projects/{id}": {
      get: {
        summary: "Get a single project",
        tags: ["Projects"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          200: { description: "Project object", content: { "application/json": { schema: { $ref: "#/components/schemas/Project" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/history": {
      get: {
        summary: "Score history for a project",
        tags: ["History"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
          { name: "from", in: "query", schema: { type: "integer" }, description: "Start timestamp (ms)" },
          { name: "to", in: "query", schema: { type: "integer" }, description: "End timestamp (ms)" },
          { name: "format", in: "query", schema: { type: "string", enum: ["json", "csv"] } },
        ],
        responses: {
          200: { description: "Score history entries or CSV download" },
        },
      },
    },
    "/projects/{id}/history/trend": {
      get: {
        summary: "Score trend for a project",
        tags: ["History"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          200: { description: "Trend result", content: { "application/json": { schema: { $ref: "#/components/schemas/Trend" } } } },
        },
      },
    },
    "/portfolio": {
      get: {
        summary: "Get portfolio summary",
        tags: ["Portfolio"],
        responses: { 200: { description: "Portfolio metrics" } },
      },
    },
    "/admin/score-update": {
      post: {
        summary: "Trigger a manual score update",
        tags: ["Admin"],
        security: [{ UserId: [] }],
        responses: {
          200: { description: "Score updated" },
          401: { description: "Unauthorized" },
        },
      },
    },
    "/admin/batch/score-update": {
      post: {
        summary: "Enqueue a batch score-update job",
        tags: ["Admin", "Batch"],
        security: [{ UserId: [] }],
        responses: {
          202: { description: "Job accepted", content: { "application/json": { schema: { $ref: "#/components/schemas/BatchJob" } } } },
          401: { description: "Unauthorized" },
        },
      },
    },
    "/admin/batch/{batchId}/status": {
      get: {
        summary: "Get batch job status",
        tags: ["Admin", "Batch"],
        security: [{ UserId: [] }],
        parameters: [{ name: "batchId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Job status", content: { "application/json": { schema: { $ref: "#/components/schemas/BatchJob" } } } },
          404: { description: "Job not found" },
        },
      },
    },
    "/roles": {
      get: {
        summary: "List all role assignments",
        tags: ["Roles"],
        security: [{ UserId: [] }],
        responses: { 200: { description: "Array of role entries" } },
      },
      post: {
        summary: "Assign a role to a user",
        tags: ["Roles"],
        security: [{ UserId: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Role" },
            },
          },
        },
        responses: {
          201: { description: "Role assigned" },
          400: { description: "Invalid role" },
          403: { description: "Insufficient permissions" },
        },
      },
    },
    "/roles/{userId}": {
      delete: {
        summary: "Remove a role from a user",
        tags: ["Roles"],
        security: [{ UserId: [] }],
        parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Role removed" },
          404: { description: "User not found" },
        },
      },
    },
    "/webhooks": {
      get: {
        summary: "List registered webhooks",
        tags: ["Webhooks"],
        security: [{ UserId: [] }],
        responses: { 200: { description: "Array of webhook configs" } },
      },
      post: {
        summary: "Register a new webhook",
        tags: ["Webhooks"],
        security: [{ UserId: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url", "secret"],
                properties: {
                  url: { type: "string" },
                  secret: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Webhook registered", content: { "application/json": { schema: { $ref: "#/components/schemas/Webhook" } } } },
        },
      },
    },
    "/webhooks/{id}": {
      get: {
        summary: "Get a webhook by ID",
        tags: ["Webhooks"],
        security: [{ UserId: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Webhook config" },
          404: { description: "Not found" },
        },
      },
      delete: {
        summary: "Remove a webhook",
        tags: ["Webhooks"],
        security: [{ UserId: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Webhook removed" },
          404: { description: "Not found" },
        },
      },
    },
  },
};
