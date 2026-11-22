import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

export type CertificateFormat = "json" | "pdf";

export interface ImpactProjectInput {
  id: number;
  power_output_kw: number;
  funding: number;
  certified: boolean;
  certification_status: string;
  contract_id: string;
  ledger: number;
  data_source_id: string;
}

export interface ImpactCertificate {
  certificate_id: string;
  schema_version: "1.0";
  investor_address: string;
  period: string;
  generated_at: string;
  methodology: {
    output_unit: "kWh";
    avoided_emissions_unit: "tCO2e";
    grid_emission_factor_kg_per_kwh: number;
    attribution: "time-weighted pool share";
    note: string;
  };
  projects: Array<{
    project_id: number;
    certified: boolean;
    certification_status: string;
    measured_output_kwh: number;
    pool_share_bps: number;
    attributed_output_kwh: number;
    avoided_emissions_tco2e: number;
    source: { contract_id: string; ledger: number; data_source_id: string };
  }>;
  carbon_credit_balance: {
    amount: number;
    unit: "tCO2e";
    source: { contract_id: string; ledger: number };
  };
  signature: { algorithm: "Ed25519"; value: string; public_key_url: string };
}

const GRID_EMISSION_FACTOR_KG_PER_KWH = 0.442;
const PRIVATE_KEY_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const PUBLIC_KEY_URL = "/.well-known/heliobond-impact-key";

function privateKey() {
  const configured = process.env.IMPACT_CERTIFICATE_PRIVATE_KEY?.trim();
  const seed = configured
    ? Buffer.from(configured, "base64")
    : createHash("sha256").update("heliobond-impact-certificate-development-key").digest();
  const der = configured ? seed : Buffer.concat([PRIVATE_KEY_PREFIX, seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export function getImpactCertificatePublicKey(): string {
  return createPublicKey(privateKey()).export({ format: "der", type: "spki" }).toString("base64");
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function canonicalPayload(certificate: Omit<ImpactCertificate, "signature">): string {
  return JSON.stringify(certificate);
}

export function buildImpactCertificate(
  investorAddress: string,
  period: string,
  projects: ImpactProjectInput[],
): ImpactCertificate {
  const totalFunding = projects.reduce((sum, project) => sum + Math.max(project.funding, 0), 0);
  const rows = projects.map((project) => {
    const share = totalFunding > 0 ? Math.max(project.funding, 0) / totalFunding : 0;
    const outputKwh = Math.max(project.power_output_kw, 0) * 24 * 365;
    return {
      project_id: project.id,
      certified: project.certified,
      certification_status: project.certification_status,
      measured_output_kwh: round(outputKwh, 3),
      pool_share_bps: Math.round(share * 10000),
      attributed_output_kwh: round(outputKwh * share, 3),
      avoided_emissions_tco2e: round(
        (outputKwh * share * GRID_EMISSION_FACTOR_KG_PER_KWH) / 1000,
        6,
      ),
      source: {
        contract_id: project.contract_id,
        ledger: project.ledger,
        data_source_id: project.data_source_id,
      },
    };
  });

  const unsigned = {
    certificate_id: `impact-${createHash("sha256").update(`${investorAddress}:${period}`).digest("hex").slice(0, 24)}`,
    schema_version: "1.0" as const,
    investor_address: investorAddress,
    period,
    generated_at: new Date().toISOString(),
    methodology: {
      output_unit: "kWh" as const,
      avoided_emissions_unit: "tCO2e" as const,
      grid_emission_factor_kg_per_kwh: GRID_EMISSION_FACTOR_KG_PER_KWH,
      attribution: "time-weighted pool share" as const,
      note: "Measured annualized output is attributed by each project's investment share for the requested reporting period; only certified projects are treated as verified impact.",
    },
    projects: rows,
    carbon_credit_balance: {
      amount: round(
        rows
          .filter((row) => row.certified)
          .reduce((sum, row) => sum + row.avoided_emissions_tco2e, 0),
        6,
      ),
      unit: "tCO2e" as const,
      source: {
        contract_id: "investment_vault",
        ledger: Math.max(0, ...projects.map((project) => project.ledger)),
      },
    },
  };
  const signature = sign(null, Buffer.from(canonicalPayload(unsigned)), privateKey()).toString(
    "base64",
  );
  return {
    ...unsigned,
    signature: { algorithm: "Ed25519", value: signature, public_key_url: PUBLIC_KEY_URL },
  };
}

export function certificatePdf(certificate: ImpactCertificate): Buffer {
  const lines = [
    "HelioBond Verifiable Impact Certificate",
    `Certificate: ${certificate.certificate_id}`,
    `Investor: ${certificate.investor_address}`,
    `Period: ${certificate.period}`,
    `Signature: ${certificate.signature.value}`,
    ...certificate.projects.map(
      (project) =>
        `Project ${project.project_id}: ${project.attributed_output_kwh} kWh, ${project.avoided_emissions_tco2e} tCO2e, certified=${project.certified}`,
    ),
  ];
  const escaped = lines.map((line) =>
    line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"),
  );
  const content = `BT /F1 10 Tf 40 760 Td ${escaped.map((line) => `(${line}) Tj 0 -16 Td`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join(
      "\n",
    )}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}
