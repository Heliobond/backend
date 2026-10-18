jest.mock("../config", () => {
  const actual = jest.requireActual("../config");
  return {
    ...actual,
    config: {
      ...actual.config,
      PROJECT_REGISTRY_CONTRACT_ID: "CCJZK7ZYK5N4T6Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5",
      ADMIN_SECRET_KEY: "SABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    },
  };
});

import request from "supertest";
import { app } from "../index";

describe("GraphiQL playground SRI integrity and security headers", () => {
  const endpoints = ["/graphql-playground", "/graphiql"] as const;

  const expectedAssets = [
    {
      name: "graphiql css",
      urlPattern: /https:\/\/unpkg\.com\/graphiql@1\.8\.8\/graphiql\.min\.css/,
      expectedHash: "sha384-wsOzV0Eph4ZUUJS3E5lWAGWDmvPwKGlSAbUqoAxGs/4Xbiu5go013CHeyiHviRjk",
    },
    {
      name: "react js",
      urlPattern: /https:\/\/unpkg\.com\/react@18\.2\.0\/umd\/react\.production\.min\.js/,
      expectedHash: "sha384-tMH8h3BGESGckSAVGZ82T9n90ztNXxvdwvdM6UoR56cYcf+0iGXBliJ29D+wZ/x8",
    },
    {
      name: "react-dom js",
      urlPattern: /https:\/\/unpkg\.com\/react-dom@18\.2\.0\/umd\/react-dom\.production\.min\.js/,
      expectedHash: "sha384-bm7MnzvK++ykSwVJ2tynSE5TRdN+xL418osEVF2DE/L/gfWHj91J2Sphe582B1Bh",
    },
    {
      name: "graphiql js",
      urlPattern: /https:\/\/unpkg\.com\/graphiql@1\.8\.8\/graphiql\.min\.js/,
      expectedHash: "sha384-j7sKHA2Xh03DItLy//iDOH3EXXcIb8TZ4SmCIkPjdVZorF1a40xA9xK90NdDJGNg",
    },
  ];

  describe("Subresource Integrity (SRI) attribute verification on endpoints", () => {
    it.each(endpoints)("returns 200 OK and HTML content type on %s", async (path) => {
      const res = await request(app).get(path).expect(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    // Pairwise verification of each asset across both endpoints
    const assetEndpointPairs = endpoints.flatMap((endpoint) =>
      expectedAssets.map((asset) => ({ endpoint, ...asset })),
    );

    it.each(assetEndpointPairs)(
      "includes exact SRI hash for $name on $endpoint",
      async ({ endpoint, urlPattern, expectedHash }) => {
        const res = await request(app).get(endpoint).expect(200);
        expect(res.text).toMatch(urlPattern);
        expect(res.text).toContain(expectedHash);
      },
    );

    it.each(assetEndpointPairs)(
      "includes crossorigin attribute on tag for $name on $endpoint",
      async ({ endpoint, urlPattern }) => {
        const res = await request(app).get(endpoint).expect(200);
        const match = res.text.split("<").find((snippet) => urlPattern.test(snippet));
        expect(match).toBeDefined();
        expect(match).toMatch(/crossorigin/i);
      },
    );

    it.each(endpoints)(
      "verifies every unpkg link/script has an integrity attribute on %s",
      async (path) => {
        const res = await request(app).get(path).expect(200);
        const tags = res.text.match(/<(script|link)[^>]+unpkg\.com[^>]*>/g) || [];
        expect(tags.length).toBe(4);
        for (const tag of tags) {
          expect(tag).toMatch(/integrity=["']sha(256|384|512)-[A-Za-z0-9+/=]+["']/);
        }
      },
    );

    it.each(endpoints)(
      "verifies every integrity attribute matches W3C SRI base64 regex on %s",
      async (path) => {
        const res = await request(app).get(path).expect(200);
        const integrityMatches = res.text.match(/integrity=["']([^"']+)["']/g) || [];
        expect(integrityMatches.length).toBe(4);
        const sriRegex = /^integrity=["'](sha256|sha384|sha512)-[A-Za-z0-9+/=]{44,88}["']$/;
        for (const attr of integrityMatches) {
          expect(attr).toMatch(sriRegex);
        }
      },
    );
  });

  describe("Version pinning on external CDN resources", () => {
    it.each(endpoints)("pins graphiql CSS to version 1.8.8 on %s", async (path) => {
      const res = await request(app).get(path).expect(200);
      expect(res.text).toContain("https://unpkg.com/graphiql@1.8.8/graphiql.min.css");
      expect(res.text).not.toMatch(/href="https:\/\/unpkg\.com\/graphiql\/graphiql\.min\.css"/);
    });

    it.each(endpoints)("pins react UMD bundle to version 18.2.0 on %s", async (path) => {
      const res = await request(app).get(path).expect(200);
      expect(res.text).toContain("https://unpkg.com/react@18.2.0/umd/react.production.min.js");
      expect(res.text).not.toMatch(
        /src="https:\/\/unpkg\.com\/react\/umd\/react\.production\.min\.js"/,
      );
    });

    it.each(endpoints)("pins react-dom UMD bundle to version 18.2.0 on %s", async (path) => {
      const res = await request(app).get(path).expect(200);
      expect(res.text).toContain(
        "https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js",
      );
      expect(res.text).not.toMatch(
        /src="https:\/\/unpkg\.com\/react-dom\/umd\/react-dom\.production\.min\.js"/,
      );
    });

    it.each(endpoints)("pins graphiql JS bundle to version 1.8.8 on %s", async (path) => {
      const res = await request(app).get(path).expect(200);
      expect(res.text).toContain("https://unpkg.com/graphiql@1.8.8/graphiql.min.js");
      expect(res.text).not.toMatch(/src="https:\/\/unpkg\.com\/graphiql\/graphiql\.min\.js"/);
    });

    it.each(endpoints)(
      "ensures every resource loaded from unpkg has an explicit pinned version on %s",
      async (path) => {
        const res = await request(app).get(path).expect(200);
        const urls = res.text.match(/https:\/\/unpkg\.com\/[^"'\s]+/g) || [];
        expect(urls.length).toBe(4);
        for (const u of urls) {
          expect(u).toMatch(/https:\/\/unpkg\.com\/[a-zA-Z0-9-_]+@\d+\.\d+\.\d+/);
        }
      },
    );
  });

  describe("Content Security Policy (CSP) and Nonce isolation", () => {
    it.each(endpoints)("returns Content-Security-Policy header on %s response", async (path) => {
      const res = await request(app).get(path).expect(200);
      const csp = res.headers["content-security-policy"];
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'self'");
    });

    it.each(endpoints)(
      "verifies script-src contains 'self', unpkg CDN, and dynamic nonce on %s",
      async (path) => {
        const res = await request(app).get(path).expect(200);
        const csp = res.headers["content-security-policy"];
        expect(csp).toMatch(/script-src 'self' https:\/\/unpkg\.com 'nonce-[a-f0-9]+'/);
      },
    );

    it.each(endpoints)(
      "verifies style-src contains 'self', 'unsafe-inline', and unpkg CDN on %s",
      async (path) => {
        const res = await request(app).get(path).expect(200);
        const csp = res.headers["content-security-policy"];
        expect(csp).toMatch(/style-src 'self' 'unsafe-inline' https:\/\/unpkg\.com/);
      },
    );

    it.each(endpoints)(
      "verifies restricted directives in CSP: object-src none and frame-ancestors none on %s",
      async (path) => {
        const res = await request(app).get(path).expect(200);
        const csp = res.headers["content-security-policy"];
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'self'");
        expect(csp).toContain("form-action 'self'");
      },
    );

    it.each(endpoints)(
      "verifies inline bootstrap script includes nonce matching CSP header on %s",
      async (path) => {
        const res = await request(app).get(path).expect(200);
        const csp = res.headers["content-security-policy"];
        const nonceMatch = csp.match(/'nonce-([a-f0-9]+)'/);
        expect(nonceMatch).not.toBeNull();
        const nonce = nonceMatch![1];
        expect(res.text).toContain(`<script nonce="${nonce}">`);
      },
    );

    it("verifies consecutive requests generate distinct nonces without repetition", async () => {
      const nonces = new Set<string>();
      for (let i = 0; i < 15; i++) {
        const res = await request(app).get("/graphiql").expect(200);
        const match = res.headers["content-security-policy"].match(/'nonce-([a-f0-9]+)'/);
        expect(match).not.toBeNull();
        nonces.add(match![1]);
      }
      expect(nonces.size).toBe(15);
    });
  });

  describe("DOM structure and GraphiQL playground initialization", () => {
    it.each(endpoints)("contains valid html boilerplate with title on %s", async (path) => {
      const res = await request(app).get(path).expect(200);
      expect(res.text).toContain("<!DOCTYPE html>");
      expect(res.text).toContain("<title>GraphiQL</title>");
      expect(res.text).toContain('<div id="graphiql" style="height: 100vh;"></div>');
    });

    it.each(endpoints)("configures GraphQL fetcher pointing to /graphql on %s", async (path) => {
      const res = await request(app).get(path).expect(200);
      expect(res.text).toContain("const fetcher = GraphiQL.createFetcher({ url: '/graphql' });");
    });

    it.each(endpoints)("renders GraphiQL component into DOM container on %s", async (path) => {
      const res = await request(app).get(path).expect(200);
      expect(res.text).toContain("ReactDOM.render(");
      expect(res.text).toContain("React.createElement(GraphiQL, { fetcher: fetcher })");
      expect(res.text).toContain("document.getElementById('graphiql')");
    });
  });

  describe("Negative controls and defense-in-depth verification", () => {
    it.each(endpoints)("does not load any insecure http:// resources on %s", async (path) => {
      const res = await request(app).get(path).expect(200);
      expect(res.text).not.toMatch(/src="http:\/\//i);
      expect(res.text).not.toMatch(/href="http:\/\//i);
    });

    it.each(endpoints)(
      "ensures no unauthorized inline scripts exist without nonce on %s",
      async (path) => {
        const res = await request(app).get(path).expect(200);
        const scriptTags = res.text.match(/<script(?![^>]*src=)[^>]*>/g) || [];
        expect(scriptTags.length).toBe(1);
        expect(scriptTags[0]).toMatch(/<script nonce="[a-f0-9]+">/);
      },
    );

    it.each(endpoints)(
      "does not expose GraphQL schema or keys inside playground HTML on %s",
      async (path) => {
        const res = await request(app).get(path).expect(200);
        expect(res.text).not.toContain("API_KEY");
        expect(res.text).not.toContain("ADMIN_KEY");
        expect(res.text).not.toContain("SECRET");
      },
    );

    it("does not reflect unescaped query parameters into HTML", async () => {
      const payload = "alert('xss')";
      const res = await request(app)
        .get(`/graphiql?q=${encodeURIComponent(payload)}`)
        .expect(200);
      expect(res.text).not.toContain(payload);
    });

    const disallowedMethods = ["post", "put", "delete", "patch"] as const;
    it.each(disallowedMethods)("rejects %s method on /graphql-playground", async (method) => {
      const res = await (request(app) as any)[method]("/graphql-playground");
      expect([403, 404, 405]).toContain(res.status);
    });

    it.each(disallowedMethods)("rejects %s method on /graphiql", async (method) => {
      const res = await (request(app) as any)[method]("/graphiql");
      expect([403, 404, 405]).toContain(res.status);
    });
  });

  describe("Parametric stress and concurrency verification", () => {
    const iterations = Array.from({ length: 25 }, (_, i) => i + 1);

    it.each(iterations)("handles consecutive request #%d on /graphql-playground", async () => {
      const res = await request(app).get("/graphql-playground").expect(200);
      expect(res.text).toContain(
        "sha384-wsOzV0Eph4ZUUJS3E5lWAGWDmvPwKGlSAbUqoAxGs/4Xbiu5go013CHeyiHviRjk",
      );
      expect(res.text).toContain(
        "sha384-tMH8h3BGESGckSAVGZ82T9n90ztNXxvdwvdM6UoR56cYcf+0iGXBliJ29D+wZ/x8",
      );
      expect(res.text).toContain(
        "sha384-bm7MnzvK++ykSwVJ2tynSE5TRdN+xL418osEVF2DE/L/gfWHj91J2Sphe582B1Bh",
      );
      expect(res.text).toContain(
        "sha384-j7sKHA2Xh03DItLy//iDOH3EXXcIb8TZ4SmCIkPjdVZorF1a40xA9xK90NdDJGNg",
      );
    });

    it.each(iterations)("handles consecutive request #%d on /graphiql", async () => {
      const res = await request(app).get("/graphiql").expect(200);
      expect(res.text).toContain(
        "sha384-wsOzV0Eph4ZUUJS3E5lWAGWDmvPwKGlSAbUqoAxGs/4Xbiu5go013CHeyiHviRjk",
      );
      expect(res.text).toContain(
        "sha384-tMH8h3BGESGckSAVGZ82T9n90ztNXxvdwvdM6UoR56cYcf+0iGXBliJ29D+wZ/x8",
      );
      expect(res.text).toContain(
        "sha384-bm7MnzvK++ykSwVJ2tynSE5TRdN+xL418osEVF2DE/L/gfWHj91J2Sphe582B1Bh",
      );
      expect(res.text).toContain(
        "sha384-j7sKHA2Xh03DItLy//iDOH3EXXcIb8TZ4SmCIkPjdVZorF1a40xA9xK90NdDJGNg",
      );
    });

    it("handles concurrent requests across both routes without nonce collision", async () => {
      const promises = [
        ...Array.from({ length: 15 }, () => request(app).get("/graphql-playground")),
        ...Array.from({ length: 15 }, () => request(app).get("/graphiql")),
      ];
      const responses = await Promise.all(promises);
      const nonces = new Set<string>();

      for (const res of responses) {
        expect(res.status).toBe(200);
        const match = res.headers["content-security-policy"].match(/'nonce-([a-f0-9]+)'/);
        expect(match).not.toBeNull();
        nonces.add(match![1]);
      }
      expect(nonces.size).toBe(30);
    });
  });
});
