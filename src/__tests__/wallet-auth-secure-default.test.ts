/**
 * Regression tests for #832 — walletAuth previously accepted a client that
 * supplied only `x-wallet-address` whenever `WALLET_AUTH_REQUIRE_SIGNATURE`
 * was not set to `"true"`, and `.env.example` shipped it as `"false"`. The
 * creator identity used by `/v1/creators/*` was therefore spoofable by any
 * client that chose a Stellar address.
 *
 * These tests pin the secure default (signature required unless opted out)
 * and the raw-body / canonical signing contract, so the body-serialization
 * mismatch between client and server can no longer flip legitimate requests
 * to 401.
 */

import request from "supertest";
import express, { Express } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { walletAuth, walletChallenge } from "../middleware/walletAuth";
import { errorHandler } from "../middleware/errors";

function buildApp(): Express {
  const app = express();
  // Mirror src/index.ts: capture raw bytes so walletAuth can verify over
  // exactly what the client signed, not a re-stringified parse.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.post("/protected", walletAuth, (req, res) => {
    res.json({ ok: true, wallet: req.walletAddress });
  });
  app.use(errorHandler);
  return app;
}

function signRequest(
  keypair: Keypair,
  method: string,
  path: string,
  body: string,
  timestamp: string,
): string {
  const challenge = walletChallenge(timestamp, method, path, body);
  return Buffer.from(keypair.sign(Buffer.from(challenge, "utf8"))).toString("base64");
}

describe("walletAuth secure default + raw-body signing (#832)", () => {
  let app: Express;
  const originalRequireFlag = process.env.WALLET_AUTH_REQUIRE_SIGNATURE;

  beforeEach(() => {
    delete process.env.WALLET_AUTH_REQUIRE_SIGNATURE;
    app = buildApp();
  });

  afterAll(() => {
    if (originalRequireFlag === undefined) delete process.env.WALLET_AUTH_REQUIRE_SIGNATURE;
    else process.env.WALLET_AUTH_REQUIRE_SIGNATURE = originalRequireFlag;
  });

  it("rejects a request carrying only x-wallet-address under the default (fail-closed)", async () => {
    const keypair = Keypair.random();
    const res = await request(app)
      .post("/protected")
      .set("x-wallet-address", keypair.publicKey())
      .send({ name: "spoofed" })
      .expect(401);
    expect(res.body?.error?.message ?? res.body?.message ?? "").toMatch(/Missing|signature/i);
  });

  it("accepts a valid signed request with x-wallet-signature + x-wallet-timestamp", async () => {
    const keypair = Keypair.random();
    const timestamp = Date.now().toString();
    const bodyObj = { capacity_kw: 42, name: "Test" };
    const bodyBytes = JSON.stringify(bodyObj);
    const signature = signRequest(keypair, "POST", "/protected", bodyBytes, timestamp);

    const res = await request(app)
      .post("/protected")
      .set("x-wallet-address", keypair.publicKey())
      .set("x-wallet-signature", signature)
      .set("x-wallet-timestamp", timestamp)
      .set("content-type", "application/json")
      .send(bodyBytes)
      .expect(200);
    expect(res.body).toEqual({ ok: true, wallet: keypair.publicKey() });
  });

  it("rejects a signature forged under a different address", async () => {
    const victim = Keypair.random();
    const attacker = Keypair.random();
    const timestamp = Date.now().toString();
    const bodyBytes = JSON.stringify({ anything: 1 });
    const signatureByAttacker = signRequest(attacker, "POST", "/protected", bodyBytes, timestamp);

    await request(app)
      .post("/protected")
      // Claims to be the victim; signature is really the attacker's.
      .set("x-wallet-address", victim.publicKey())
      .set("x-wallet-signature", signatureByAttacker)
      .set("x-wallet-timestamp", timestamp)
      .set("content-type", "application/json")
      .send(bodyBytes)
      .expect(401);
  });

  it("rejects a replay with a stale x-wallet-timestamp", async () => {
    const keypair = Keypair.random();
    // 6 minutes ago — walletAuth caps the window at 5 minutes.
    const timestamp = (Date.now() - 6 * 60 * 1000).toString();
    const bodyBytes = JSON.stringify({ anything: 1 });
    const signature = signRequest(keypair, "POST", "/protected", bodyBytes, timestamp);

    await request(app)
      .post("/protected")
      .set("x-wallet-address", keypair.publicKey())
      .set("x-wallet-signature", signature)
      .set("x-wallet-timestamp", timestamp)
      .set("content-type", "application/json")
      .send(bodyBytes)
      .expect(401);
  });

  it("verifies against the raw body bytes, so key-order differences do not flip 401", async () => {
    // Client sends keys in a specific order; the request builder keeps the
    // bytes as sent. walletAuth must hash those bytes rather than a
    // re-stringified parse that could reorder keys.
    const keypair = Keypair.random();
    const timestamp = Date.now().toString();
    const bodyBytes = `{"zed":1,"alpha":2}`;
    const signature = signRequest(keypair, "POST", "/protected", bodyBytes, timestamp);

    const res = await request(app)
      .post("/protected")
      .set("x-wallet-address", keypair.publicKey())
      .set("x-wallet-signature", signature)
      .set("x-wallet-timestamp", timestamp)
      .set("content-type", "application/json")
      .send(bodyBytes)
      .expect(200);
    expect(res.body.ok).toBe(true);
  });

  it("still accepts address-only when WALLET_AUTH_REQUIRE_SIGNATURE=false (opt-out)", async () => {
    process.env.WALLET_AUTH_REQUIRE_SIGNATURE = "false";
    app = buildApp();
    const keypair = Keypair.random();
    await request(app)
      .post("/protected")
      .set("x-wallet-address", keypair.publicKey())
      .send({ name: "dev-mode" })
      .expect(200);
  });
});
