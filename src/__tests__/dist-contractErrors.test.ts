describe("dist contractErrors smoke test", () => {
  it("loads the compiled contractErrors module from dist", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../dist/lib/contractErrors");
    expect(mod.getContractErrorTable).toBeDefined();
    expect(mod.loadContractErrorTable).toBeDefined();
    expect(mod.lookupContractError("registry", 7)).toMatchObject({
      name: "ProjectNotFound",
      code: 7,
    });
  });
});
