import {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLError,
  GraphQLSchema,
  Kind,
  OperationDefinitionNode,
  SelectionSetNode,
  ValidationOptions,
  ValidationRule,
  validate,
} from "graphql";

/**
 * Defaults are deliberately generous enough for the schema in this service
 * (whose deepest field path is three selections) while still bounding the
 * work a single request can trigger.
 */
export const GRAPHQL_SECURITY_DEFAULTS = {
  maxDepth: 12,
  maxComplexity: 1000,
  maxRootFields: 20,
} as const;

export interface GraphQLSecurityLimits {
  /** Maximum number of nested field selections in one operation. */
  maxDepth: number;
  /** Maximum number of field selections (aliases and fragment expansions included). */
  maxComplexity: number;
  /** Maximum number of top-level fields/aliases in one operation. */
  maxRootFields: number;
  /** Whether `__schema` / `__type` introspection is permitted. */
  allowIntrospection: boolean;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function envBoolean(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/**
 * Resolve limits at request-validation time so deployments and tests can
 * change them without reloading the module.
 *
 * Introspection defaults to disabled in production and enabled elsewhere.
 * `GRAPHQL_ALLOW_INTROSPECTION` overrides that default either way.
 */
export function getGraphQLSecurityLimits(
  overrides: Partial<GraphQLSecurityLimits> = {},
): GraphQLSecurityLimits {
  const production = process.env.NODE_ENV === "production";
  return {
    maxDepth:
      overrides.maxDepth ?? envPositiveInt("GRAPHQL_MAX_DEPTH", GRAPHQL_SECURITY_DEFAULTS.maxDepth),
    maxComplexity:
      overrides.maxComplexity ??
      envPositiveInt("GRAPHQL_MAX_COMPLEXITY", GRAPHQL_SECURITY_DEFAULTS.maxComplexity),
    maxRootFields:
      overrides.maxRootFields ??
      envPositiveInt("GRAPHQL_MAX_ROOT_FIELDS", GRAPHQL_SECURITY_DEFAULTS.maxRootFields),
    allowIntrospection:
      overrides.allowIntrospection ?? envBoolean("GRAPHQL_ALLOW_INTROSPECTION") ?? !production,
  };
}

interface QueryStats {
  maxDepth: number;
  complexity: number;
  rootFields: number;
  usesIntrospection: boolean;
}

function collectFragments(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  return fragments;
}

/**
 * Walk one selection set and accumulate the work it represents.
 *
 * Fragment spreads are expanded at their use site (so repeated aliases are
 * counted each time) and `fragmentPath` breaks cycles. Cyclic documents are
 * rejected by the GraphQL spec validation rules; the guard here only keeps
 * this analysis from recursing forever on a malformed document.
 */
function analyzeSelectionSet(
  selectionSet: SelectionSetNode,
  depth: number,
  fragments: Map<string, FragmentDefinitionNode>,
  fragmentPath: Set<string>,
  stats: QueryStats,
  rootLevel: boolean,
): void {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const field = selection as FieldNode;
      if (rootLevel) stats.rootFields += 1;
      stats.complexity += 1;

      if (field.name.value === "__schema" || field.name.value === "__type") {
        stats.usesIntrospection = true;
      }

      const fieldDepth = depth + 1;
      if (fieldDepth > stats.maxDepth) stats.maxDepth = fieldDepth;

      if (field.selectionSet) {
        analyzeSelectionSet(field.selectionSet, fieldDepth, fragments, fragmentPath, stats, false);
      }
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      analyzeSelectionSet(selection.selectionSet, depth, fragments, fragmentPath, stats, rootLevel);
      continue;
    }

    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (fragmentPath.has(name)) continue;

      const fragment = fragments.get(name);
      if (!fragment) continue;

      fragmentPath.add(name);
      analyzeSelectionSet(fragment.selectionSet, depth, fragments, fragmentPath, stats, rootLevel);
      fragmentPath.delete(name);
    }
  }
}

function operationLabel(operation: OperationDefinitionNode): string {
  return operation.name ? `Operation "${operation.name.value}"` : "Anonymous operation";
}

/**
 * Analyze a parsed document and return one error per violated limit.
 *
 * This runs as part of GraphQL validation, i.e. before any resolver executes,
 * so an over-budget query never reaches DataLoader/database/RPC code.
 */
export function analyzeGraphQLDocument(
  document: DocumentNode,
  limits: GraphQLSecurityLimits = getGraphQLSecurityLimits(),
): GraphQLError[] {
  const fragments = collectFragments(document);
  const errors: GraphQLError[] = [];

  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;

    const stats: QueryStats = {
      maxDepth: 0,
      complexity: 0,
      rootFields: 0,
      usesIntrospection: false,
    };
    analyzeSelectionSet(definition.selectionSet, 0, fragments, new Set(), stats, true);

    const label = operationLabel(definition);

    if (stats.maxDepth > limits.maxDepth) {
      errors.push(
        new GraphQLError(
          `${label} has depth ${stats.maxDepth}, exceeding the maximum allowed depth of ${limits.maxDepth}.`,
          {
            nodes: [definition],
            extensions: {
              code: "GRAPHQL_MAX_DEPTH_EXCEEDED",
              depth: stats.maxDepth,
              maxDepth: limits.maxDepth,
            },
          },
        ),
      );
    }

    if (stats.complexity > limits.maxComplexity) {
      errors.push(
        new GraphQLError(
          `${label} has complexity ${stats.complexity}, exceeding the maximum allowed complexity of ${limits.maxComplexity}.`,
          {
            nodes: [definition],
            extensions: {
              code: "GRAPHQL_MAX_COMPLEXITY_EXCEEDED",
              complexity: stats.complexity,
              maxComplexity: limits.maxComplexity,
            },
          },
        ),
      );
    }

    if (stats.rootFields > limits.maxRootFields) {
      errors.push(
        new GraphQLError(
          `${label} requests ${stats.rootFields} root fields/aliases, exceeding the maximum of ${limits.maxRootFields}.`,
          {
            nodes: [definition],
            extensions: {
              code: "GRAPHQL_MAX_ROOT_FIELDS_EXCEEDED",
              rootFields: stats.rootFields,
              maxRootFields: limits.maxRootFields,
            },
          },
        ),
      );
    }

    if (!limits.allowIntrospection && stats.usesIntrospection) {
      errors.push(
        new GraphQLError(
          `${label} uses introspection (__schema/__type), which is disabled in this environment.`,
          {
            nodes: [definition],
            extensions: { code: "GRAPHQL_INTROSPECTION_DISABLED" },
          },
        ),
      );
    }
  }

  return errors;
}

/**
 * Drop-in replacement for `graphql.validate` that appends the
 * depth/complexity/alias/introspection checks used by the HTTP handler.
 *
 * Standard validation errors short-circuit the analysis: an invalid document
 * is already rejected before execution and there is no need to spend more
 * time walking it.
 */
export function validateGraphQLDocument(
  schema: GraphQLSchema,
  document: DocumentNode,
  rules?: ReadonlyArray<ValidationRule>,
  options?: ValidationOptions,
): ReadonlyArray<GraphQLError> {
  const errors = validate(schema, document, rules, options);
  if (errors.length > 0) return errors;
  return analyzeGraphQLDocument(document);
}
