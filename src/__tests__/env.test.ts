import { validateEnv } from "../lib/env";

const REQUIRED = {
  ADMIN_SECRET_KEY: "SCZANGBA5RLQPECZ5BRKN6MJVHKH63MMM7WKEA6VZBULQJFBXJXLHZS",
  PROJECT_REGISTRY_CONTRACT_ID: "CBIELTK6YBZJU5UP2WWQEQ4YY3QVDCVV2DLYIMT6MVQZYRMBQ3YWBP",
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

beforeEach(() => {
  // Ensure required vars are present for each test unless explicitly overridden.
  process.env.ADMIN_SECRET_KEY = REQUIRED.ADMIN_SECRET_KEY;
  process.env.PROJECT_REGISTRY_CONTRACT_ID = REQUIRED.PROJECT_REGISTRY_CONTRACT_ID;
});

afterEach(() => {
  delete process.env.ADMIN_SECRET_KEY;
  delete process.env.PROJECT_REGISTRY_CONTRACT_ID;
});

describe("validateEnv – defaults", () => {
  it("returns defaults when only required vars are set", () => {
    const result = validateEnv();
    expect(result.STELLAR_NETWORK).toBe("testnet");
    expect(result.PORT).toBe(3001);
    expect(result.FRONTEND_URL).toBe("http://localhost:3000");
    expect(result.RPC_URL).toBe("https://soroban-testnet.stellar.org");
    expect(result.LOG_LEVEL).toBe("info");
    expect(result.DB_POOL_MIN).toBe(2);
    expect(result.DB_POOL_MAX).toBe(10);
    expect(result.DB_POOL_ACQUIRE_TIMEOUT_MS).toBe(5000);
    expect(result.DB_POOL_HEALTH_CHECK_INTERVAL_MS).toBe(30000);
    expect(result.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(result.RATE_LIMIT_MAX).toBe(100);
    expect(result.RATE_LIMIT_ADMIN_MAX).toBe(20);
    expect(result.EMAIL_FROM).toBe("no-reply@heliobond.dev");
  });

  it("RATE_LIMIT_ADMIN_WINDOW_MS defaults to RATE_LIMIT_WINDOW_MS", () => {
    withEnv({ RATE_LIMIT_WINDOW_MS: "120000" }, () => {
      const result = validateEnv();
      expect(result.RATE_LIMIT_WINDOW_MS).toBe(120_000);
      expect(result.RATE_LIMIT_ADMIN_WINDOW_MS).toBe(120_000);
    });
  });

  it("STELLAR_RPC_URL defaults to RPC_URL", () => {
    withEnv({ RPC_URL: "https://my-rpc.example.com" }, () => {
      const result = validateEnv();
      expect(result.STELLAR_RPC_URL).toBe("https://my-rpc.example.com");
    });
  });
});

describe("validateEnv – required vars", () => {
  it("exits when ADMIN_SECRET_KEY is missing", () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    withEnv({ ADMIN_SECRET_KEY: undefined }, () => {
      expect(() => validateEnv()).toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
    exitSpy.mockRestore();
  });

  it("exits when PROJECT_REGISTRY_CONTRACT_ID is missing", () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    withEnv({ PROJECT_REGISTRY_CONTRACT_ID: undefined }, () => {
      expect(() => validateEnv()).toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
    exitSpy.mockRestore();
  });
});

describe("validateEnv – type checking", () => {
  it("accepts valid STELLAR_NETWORK values", () => {
    withEnv({ STELLAR_NETWORK: "mainnet" }, () => {
      expect(validateEnv().STELLAR_NETWORK).toBe("mainnet");
    });
    withEnv({ STELLAR_NETWORK: "testnet" }, () => {
      expect(validateEnv().STELLAR_NETWORK).toBe("testnet");
    });
  });

  it("exits on invalid STELLAR_NETWORK", () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    withEnv({ STELLAR_NETWORK: "devnet" }, () => {
      expect(() => validateEnv()).toThrow("process.exit");
    });
    exitSpy.mockRestore();
  });

  it("parses PORT as a positive integer", () => {
    withEnv({ PORT: "8080" }, () => {
      expect(validateEnv().PORT).toBe(8080);
    });
  });

  it("exits on non-integer PORT", () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    withEnv({ PORT: "abc" }, () => {
      expect(() => validateEnv()).toThrow("process.exit");
    });
    exitSpy.mockRestore();
  });

  it("exits on zero or negative PORT", () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    withEnv({ PORT: "0" }, () => {
      expect(() => validateEnv()).toThrow("process.exit");
    });
    exitSpy.mockRestore();
  });

  it("exits on invalid FRONTEND_URL", () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    withEnv({ FRONTEND_URL: "not-a-url" }, () => {
      expect(() => validateEnv()).toThrow("process.exit");
    });
    exitSpy.mockRestore();
  });

  it("accepts valid LOG_LEVEL values", () => {
    for (const level of ["error", "warn", "info", "debug"] as const) {
      withEnv({ LOG_LEVEL: level }, () => {
        expect(validateEnv().LOG_LEVEL).toBe(level);
      });
    }
  });

  it("exits on invalid LOG_LEVEL", () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    withEnv({ LOG_LEVEL: "verbose" }, () => {
      expect(() => validateEnv()).toThrow("process.exit");
    });
    exitSpy.mockRestore();
  });
});

describe("validateEnv – pool constraints", () => {
  it("exits when DB_POOL_MIN > DB_POOL_MAX", () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    withEnv({ DB_POOL_MIN: "15", DB_POOL_MAX: "5" }, () => {
      expect(() => validateEnv()).toThrow("process.exit");
    });
    exitSpy.mockRestore();
  });
});

describe("validateEnv – optional vars", () => {
  it("parses optional multichain vars when provided", () => {
    withEnv(
      {
        ETH_RPC_URL: "https://mainnet.infura.io/v3/key",
        ETH_CONTRACT_ADDRESS: "0xdeadbeef",
        POLYGON_RPC_URL: "https://polygon-rpc.com",
        POLYGON_CONTRACT_ADDRESS: "0xcafe",
      },
      () => {
        const result = validateEnv();
        expect(result.ETH_RPC_URL).toBe("https://mainnet.infura.io/v3/key");
        expect(result.ETH_CONTRACT_ADDRESS).toBe("0xdeadbeef");
        expect(result.POLYGON_RPC_URL).toBe("https://polygon-rpc.com");
        expect(result.POLYGON_CONTRACT_ADDRESS).toBe("0xcafe");
      }
    );
  });

  it("returns undefined for unset optional vars", () => {
    const result = validateEnv();
    expect(result.ETH_RPC_URL).toBeUndefined();
    expect(result.POLYGON_RPC_URL).toBeUndefined();
    expect(result.ADMIN_API_KEY).toBeUndefined();
    expect(result.SENDGRID_API_KEY).toBeUndefined();
  });
});
