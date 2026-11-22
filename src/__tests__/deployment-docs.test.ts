import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../");

describe("deployment documentation service inventory", () => {
  it("does not document a Redis service that compose does not define", () => {
    const docs = fs.readFileSync(path.join(ROOT, "docs", "DEPLOYMENT.md"), "utf8");
    expect(docs).not.toMatch(/Redis memory|Redis CPU|Redis is capped/i);
  });
});