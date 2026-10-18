import {
  ValidationContext,
  ASTVisitor,
  GraphQLError,
  ValidationRule,
  OperationDefinitionNode,
  FieldNode,
  SelectionNode,
} from "graphql";

/**
 * Standard configuration defaults for GraphQL API protection:
 * - Depth Limit: Caps maximum nested selections to prevent recursive/deep AST exhaustion.
 * - Alias Cap: Caps number of field aliases to prevent alias fan-out multiplier attacks.
 * - Root Field Cap: Caps number of root query selections per request.
 * - Complexity Budget: Computes weighted query cost bounding bulk resolver execution.
 * - Introspection Control: Prevents schema discovery in production environments.
 */
export const DEFAULT_MAX_QUERY_DEPTH = 6;
export const DEFAULT_MAX_ALIASES = 15;
export const DEFAULT_MAX_ROOT_FIELDS = 10;
export const DEFAULT_MAX_QUERY_COMPLEXITY = 500;

export function getMaxQueryDepth(): number {
  const envVal = process.env.GRAPHQL_MAX_DEPTH;
  if (envVal !== undefined && envVal.trim() !== "") {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_QUERY_DEPTH;
}

export function getMaxAliases(): number {
  const envVal = process.env.GRAPHQL_MAX_ALIASES;
  if (envVal !== undefined && envVal.trim() !== "") {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_ALIASES;
}

export function getMaxRootFields(): number {
  const envVal = process.env.GRAPHQL_MAX_ROOT_FIELDS;
  if (envVal !== undefined && envVal.trim() !== "") {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_ROOT_FIELDS;
}

export function getMaxQueryComplexity(): number {
  const envVal = process.env.GRAPHQL_MAX_COMPLEXITY;
  if (envVal !== undefined && envVal.trim() !== "") {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_QUERY_COMPLEXITY;
}

export function isIntrospectionDisabled(): boolean {
  if (process.env.GRAPHQL_INTROSPECTION_DISABLED === "true") {
    return true;
  }
  if (process.env.GRAPHQL_INTROSPECTION_ENABLED === "true") {
    return false;
  }
  return process.env.NODE_ENV === "production";
}

/**
 * Validates maximum query depth across operations and fragment spreads.
 */
export function createDepthLimitRule(maxDepth?: number): ValidationRule {
  const limit = maxDepth ?? getMaxQueryDepth();

  return (context: ValidationContext): ASTVisitor => {
    function calculateSelectionDepth(
      node: SelectionNode,
      currentDepth: number,
      visitedFragments: Set<string>,
    ): number {
      if (node.kind === "Field") {
        if (!node.selectionSet || node.selectionSet.selections.length === 0) {
          return currentDepth;
        }
        let maxD = currentDepth;
        for (const sel of node.selectionSet.selections) {
          const d = calculateSelectionDepth(sel, currentDepth + 1, visitedFragments);
          if (d > maxD) maxD = d;
        }
        return maxD;
      }

      if (node.kind === "InlineFragment") {
        if (!node.selectionSet || node.selectionSet.selections.length === 0) {
          return currentDepth;
        }
        let maxD = currentDepth;
        for (const sel of node.selectionSet.selections) {
          const d = calculateSelectionDepth(sel, currentDepth, visitedFragments);
          if (d > maxD) maxD = d;
        }
        return maxD;
      }

      if (node.kind === "FragmentSpread") {
        const fragName = node.name.value;
        if (visitedFragments.has(fragName)) {
          return currentDepth;
        }
        const fragment = context.getFragment(fragName);
        if (!fragment || !fragment.selectionSet || fragment.selectionSet.selections.length === 0) {
          return currentDepth;
        }
        const nextVisited = new Set(visitedFragments).add(fragName);
        let maxD = currentDepth;
        for (const sel of fragment.selectionSet.selections) {
          const d = calculateSelectionDepth(sel, currentDepth, nextVisited);
          if (d > maxD) maxD = d;
        }
        return maxD;
      }

      return currentDepth;
    }

    return {
      OperationDefinition(operationNode: OperationDefinitionNode) {
        if (!operationNode.selectionSet || operationNode.selectionSet.selections.length === 0) {
          return;
        }
        let maxOperationDepth = 0;
        for (const sel of operationNode.selectionSet.selections) {
          const d = calculateSelectionDepth(sel, 1, new Set());
          if (d > maxOperationDepth) maxOperationDepth = d;
        }

        if (maxOperationDepth > limit) {
          context.reportError(
            new GraphQLError(
              `Query depth of ${maxOperationDepth} exceeds maximum allowed depth of ${limit}`,
              { nodes: operationNode },
            ),
          );
        }
      },
    };
  };
}

/**
 * Validates maximum number of aliases and root fields per request to prevent fan-out attacks.
 */
export function createAliasLimitRule(maxAliases?: number, maxRootFields?: number): ValidationRule {
  const aliasLimit = maxAliases ?? getMaxAliases();
  const rootLimit = maxRootFields ?? getMaxRootFields();

  return (context: ValidationContext): ASTVisitor => {
    function countAliases(
      node: OperationDefinitionNode | SelectionNode,
      visitedFragments: Set<string>,
    ): number {
      let count = 0;
      if (node.kind === "OperationDefinition" || node.kind === "InlineFragment") {
        if (node.selectionSet) {
          for (const sel of node.selectionSet.selections) {
            count += countAliases(sel, visitedFragments);
          }
        }
      } else if (node.kind === "Field") {
        if (node.alias) {
          count++;
        }
        if (node.selectionSet) {
          for (const sel of node.selectionSet.selections) {
            count += countAliases(sel, visitedFragments);
          }
        }
      } else if (node.kind === "FragmentSpread") {
        const fragName = node.name.value;
        if (!visitedFragments.has(fragName)) {
          const fragment = context.getFragment(fragName);
          if (fragment && fragment.selectionSet) {
            const nextVisited = new Set(visitedFragments).add(fragName);
            for (const sel of fragment.selectionSet.selections) {
              count += countAliases(sel, nextVisited);
            }
          }
        }
      }
      return count;
    }

    function countRootFields(
      operationNode: OperationDefinitionNode,
      visitedFragments: Set<string>,
    ): number {
      function countSelections(selections: readonly SelectionNode[], visited: Set<string>): number {
        let c = 0;
        for (const sel of selections) {
          if (sel.kind === "Field") {
            c++;
          } else if (sel.kind === "InlineFragment" && sel.selectionSet) {
            c += countSelections(sel.selectionSet.selections, visited);
          } else if (sel.kind === "FragmentSpread") {
            const fragName = sel.name.value;
            if (!visited.has(fragName)) {
              const fragment = context.getFragment(fragName);
              if (fragment && fragment.selectionSet) {
                const nextVisited = new Set(visited).add(fragName);
                c += countSelections(fragment.selectionSet.selections, nextVisited);
              }
            }
          }
        }
        return c;
      }

      if (!operationNode.selectionSet) return 0;
      return countSelections(operationNode.selectionSet.selections, visitedFragments);
    }

    return {
      OperationDefinition(operationNode: OperationDefinitionNode) {
        const rootCount = countRootFields(operationNode, new Set());
        if (rootCount > rootLimit) {
          context.reportError(
            new GraphQLError(
              `Query contains ${rootCount} root fields, exceeding maximum allowed limit of ${rootLimit}`,
              { nodes: operationNode },
            ),
          );
        }

        const aliasCount = countAliases(operationNode, new Set());
        if (aliasCount > aliasLimit) {
          context.reportError(
            new GraphQLError(
              `Query contains ${aliasCount} aliases, exceeding maximum allowed limit of ${aliasLimit}`,
              { nodes: operationNode },
            ),
          );
        }
      },
    };
  };
}

/**
 * Validates query execution complexity budget bounding recursive operations and list multiplier costs.
 */
export function createComplexityLimitRule(maxComplexity?: number): ValidationRule {
  const complexityLimit = maxComplexity ?? getMaxQueryComplexity();

  return (context: ValidationContext): ASTVisitor => {
    function calculateFieldCost(fieldNode: FieldNode, visitedFragments: Set<string>): number {
      let cost = 1;

      let limitMultiplier = 1;
      if (fieldNode.arguments && fieldNode.arguments.length > 0) {
        const limitArg = fieldNode.arguments.find((a) => a.name.value === "limit");
        if (limitArg && limitArg.value && limitArg.value.kind === "IntValue") {
          const parsed = parseInt(limitArg.value.value, 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            limitMultiplier = Math.min(parsed, 100);
          }
        } else if (fieldNode.name.value === "projects") {
          limitMultiplier = 10;
        }
      } else if (fieldNode.name.value === "projects") {
        limitMultiplier = 10;
      }

      if (fieldNode.selectionSet && fieldNode.selectionSet.selections.length > 0) {
        let childCost = 0;
        for (const sel of fieldNode.selectionSet.selections) {
          if (sel.kind === "Field") {
            childCost += calculateFieldCost(sel, visitedFragments);
          } else if (sel.kind === "InlineFragment" && sel.selectionSet) {
            for (const subSel of sel.selectionSet.selections) {
              if (subSel.kind === "Field") {
                childCost += calculateFieldCost(subSel, visitedFragments);
              }
            }
          } else if (sel.kind === "FragmentSpread") {
            const fragName = sel.name.value;
            if (!visitedFragments.has(fragName)) {
              const fragment = context.getFragment(fragName);
              if (fragment && fragment.selectionSet) {
                const nextVisited = new Set(visitedFragments).add(fragName);
                for (const subSel of fragment.selectionSet.selections) {
                  if (subSel.kind === "Field") {
                    childCost += calculateFieldCost(subSel, nextVisited);
                  }
                }
              }
            }
          }
        }
        cost += limitMultiplier * childCost;
      }

      return cost;
    }

    return {
      OperationDefinition(operationNode: OperationDefinitionNode) {
        if (!operationNode.selectionSet) return;
        let totalComplexity = 0;
        const visitedFragments = new Set<string>();

        for (const sel of operationNode.selectionSet.selections) {
          if (sel.kind === "Field") {
            totalComplexity += calculateFieldCost(sel, visitedFragments);
          } else if (sel.kind === "InlineFragment" && sel.selectionSet) {
            for (const subSel of sel.selectionSet.selections) {
              if (subSel.kind === "Field") {
                totalComplexity += calculateFieldCost(subSel, visitedFragments);
              }
            }
          } else if (sel.kind === "FragmentSpread") {
            const fragName = sel.name.value;
            if (!visitedFragments.has(fragName)) {
              const fragment = context.getFragment(fragName);
              if (fragment && fragment.selectionSet) {
                const nextVisited = new Set(visitedFragments).add(fragName);
                for (const subSel of fragment.selectionSet.selections) {
                  if (subSel.kind === "Field") {
                    totalComplexity += calculateFieldCost(subSel, nextVisited);
                  }
                }
              }
            }
          }
        }

        if (totalComplexity > complexityLimit) {
          context.reportError(
            new GraphQLError(
              `Query complexity of ${totalComplexity} exceeds maximum allowed complexity of ${complexityLimit}`,
              { nodes: operationNode },
            ),
          );
        }
      },
    };
  };
}

/**
 * Validates and enforces schema introspection policy.
 * When introspection is disabled (e.g. in production), queries requesting `__schema` or `__type`
 * are rejected before execution while preserving normal `__typename` query execution.
 */
export function createIntrospectionControlRule(disabled?: boolean): ValidationRule {
  const shouldDisable = disabled ?? isIntrospectionDisabled();

  return (context: ValidationContext): ASTVisitor => {
    if (!shouldDisable) {
      return {};
    }

    return {
      Field(fieldNode: FieldNode) {
        const fieldName = fieldNode.name.value;
        if (fieldName === "__schema" || fieldName === "__type") {
          context.reportError(
            new GraphQLError("GraphQL introspection is disabled in production environments", {
              nodes: fieldNode,
            }),
          );
        }
      },
    };
  };
}

export interface GraphQLValidationOptions {
  maxDepth?: number;
  maxAliases?: number;
  maxRootFields?: number;
  maxComplexity?: number;
  disableIntrospection?: boolean;
}

export function getGraphQLValidationRules(
  options: GraphQLValidationOptions = {},
): readonly ValidationRule[] {
  return [
    createDepthLimitRule(options.maxDepth),
    createAliasLimitRule(options.maxAliases, options.maxRootFields),
    createComplexityLimitRule(options.maxComplexity),
    createIntrospectionControlRule(options.disableIntrospection),
  ];
}
