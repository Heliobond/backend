import { parse } from "graphql";
import {
  analyzeGraphQLDocument,
  getGraphQLSecurityLimits,
  GraphQLSecurityLimits,
  GRAPHQL_SECURITY_DEFAULTS,
} from "../graphql/security";

function limits(overrides: Partial<GraphQLSecurityLimits> = {}) {
  return {
    maxDepth: GRAPHQL_SECURITY_DEFAULTS.maxDepth,
    maxComplexity: GRAPHQL_SECURITY_DEFAULTS.maxComplexity,
    maxRootFields: GRAPHQL_SECURITY_DEFAULTS.maxRootFields,
    allowIntrospection: false,
    ...overrides,
  };
}

describe("GraphQL query security analysis", () => {
  afterEach(() => {
    delete process.env.GRAPHQL_MAX_DEPTH;
    delete process.env.GRAPHQL_MAX_COMPLEXITY;
    delete process.env.GRAPHQL_MAX_ROOT_FIELDS;
    delete process.env.GRAPHQL_ALLOW_INTROSPECTION;
  });

  it("counts nested field depth, including inline fragments", () => {
    const document = parse(`
      query Deep {
        projects {
          ... on Project {
            solar {
              power_output_kw
            }
          }
        }
      }
    `);

    const errors = analyzeGraphQLDocument(document, limits({ maxDepth: 2 }));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("depth 3");
    expect(errors[0].extensions?.code).toBe("GRAPHQL_MAX_DEPTH_EXCEEDED");
  });

  it("expands named fragments when measuring depth", () => {
    const document = parse(`
      query Deep {
        projects {
          ...ProjectFields
        }
      }

      fragment ProjectFields on Project {
        solar {
          power_output_kw
        }
      }
    `);

    const errors = analyzeGraphQLDocument(document, limits({ maxDepth: 2 }));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("depth 3");
  });

  it("counts repeated aliases and fragment expansions in complexity", () => {
    const document = parse(`
      query Wide {
        a: projects { id }
        b: projects { id }
        ...RootFields
      }

      fragment RootFields on Query {
        c: projects { id }
      }
    `);

    // 3 root fields + 3 nested `id` fields = 6 selections.
    const errors = analyzeGraphQLDocument(document, limits({ maxComplexity: 5 }));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("complexity 6");
    expect(errors[0].extensions?.code).toBe("GRAPHQL_MAX_COMPLEXITY_EXCEEDED");
  });

  it("counts root fields supplied through fragments towards the alias cap", () => {
    const document = parse(`
      query Aliases {
        a: projects { id }
        ...MoreRootFields
      }

      fragment MoreRootFields on Query {
        b: projects { id }
      }
    `);

    const errors = analyzeGraphQLDocument(document, limits({ maxRootFields: 1 }));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("2 root fields/aliases");
    expect(errors[0].extensions?.code).toBe("GRAPHQL_MAX_ROOT_FIELDS_EXCEEDED");
  });

  it("detects __schema and __type introspection but allows __typename", () => {
    const introspection = parse(`{ __schema { queryType { name } } }`);
    const metaType = parse(`{ __type(name: "Project") { name } }`);
    const typename = parse(`{ __typename }`);

    expect(analyzeGraphQLDocument(introspection, limits())).toHaveLength(1);
    expect(analyzeGraphQLDocument(metaType, limits())).toHaveLength(1);
    expect(analyzeGraphQLDocument(typename, limits())).toHaveLength(0);
  });

  it("allows introspection when configured", () => {
    const document = parse(`{ __schema { queryType { name } } }`);

    expect(analyzeGraphQLDocument(document, limits({ allowIntrospection: true }))).toHaveLength(0);
  });

  it("does not recurse forever on cyclic fragment documents", () => {
    const document = parse(`
      query Cycle {
        projects {
          ...A
        }
      }

      fragment A on Project {
        ...B
      }

      fragment B on Project {
        ...A
      }
    `);

    expect(() => analyzeGraphQLDocument(document, limits())).not.toThrow();
  });

  it("reads limits from environment variables", () => {
    process.env.GRAPHQL_MAX_DEPTH = "4";
    process.env.GRAPHQL_MAX_COMPLEXITY = "50";
    process.env.GRAPHQL_MAX_ROOT_FIELDS = "7";

    expect(getGraphQLSecurityLimits()).toMatchObject({
      maxDepth: 4,
      maxComplexity: 50,
      maxRootFields: 7,
    });
  });

  it("falls back to defaults for invalid environment values", () => {
    process.env.GRAPHQL_MAX_DEPTH = "not-a-number";
    process.env.GRAPHQL_MAX_COMPLEXITY = "-1";

    expect(getGraphQLSecurityLimits()).toMatchObject({
      maxDepth: GRAPHQL_SECURITY_DEFAULTS.maxDepth,
      maxComplexity: GRAPHQL_SECURITY_DEFAULTS.maxComplexity,
    });
  });
});
