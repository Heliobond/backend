import { createPublicKey, verify } from "node:crypto";
import { buildImpactCertificate, getImpactCertificatePublicKey } from "../lib/impactCertificate";

describe("impact certificates", () => {
  it("attributes measured output and signs the certificate", () => {
    const certificate = buildImpactCertificate("GTEST", "2026-Q3", [
      {
        id: 1,
        power_output_kw: 10,
        funding: 100,
        certified: true,
        certification_status: "certified",
        contract_id: "vault-1",
        ledger: 42,
        data_source_id: "solar-1",
      },
    ]);
    expect(certificate.projects[0].measured_output_kwh).toBe(87600);
    expect(certificate.projects[0].pool_share_bps).toBe(10000);
    expect(certificate.signature.value).toBeTruthy();
    expect(
      createPublicKey({
        key: Buffer.from(getImpactCertificatePublicKey(), "base64"),
        format: "der",
        type: "spki",
      }),
    ).toBeTruthy();
  });
});
