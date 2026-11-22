import { hasRolePermission } from "../lib/apiKeyRoles";

describe("api key role permissions", () => {
  it("allows admin:write to access every defined resource", () => {
    expect(hasRolePermission("admin:write", "admin:read")).toBe(true);
    expect(hasRolePermission("admin:write", "admin:write")).toBe(true);
    expect(hasRolePermission("admin:write", "iot:read")).toBe(true);
  });

  it("keeps narrower roles constrained", () => {
    expect(hasRolePermission("admin:read", "admin:write")).toBe(false);
    expect(hasRolePermission("iot:read", "admin:read")).toBe(false);
  });
});
