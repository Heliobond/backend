import { Request, Response, NextFunction } from "express";

export interface ValidationSchema {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
}

interface ValidatorOptions {
  schema: ValidationSchema;
  onError?: (res: Response, error: string, status?: number) => void;
}

function validateSchema(data: unknown, schema: ValidationSchema): { valid: boolean; error?: string } {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Request body must be an object" };
  }

  const obj = data as Record<string, unknown>;

  if (schema.required) {
    for (const field of schema.required) {
      if (!(field in obj)) {
        return { valid: false, error: `Missing required field: ${field}` };
      }
      if (obj[field] === null || obj[field] === undefined) {
        return { valid: false, error: `Field ${field} cannot be null or undefined` };
      }
    }
  }

  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!(key in obj)) continue;

      const value = obj[key];

      if (propSchema.type && typeof value !== propSchema.type) {
        return {
          valid: false,
          error: `Field ${key} must be of type ${propSchema.type}, got ${typeof value}`,
        };
      }

      if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(value)) {
        return {
          valid: false,
          error: `Field ${key} must be one of: ${propSchema.enum.join(", ")}`,
        };
      }

      if (propSchema.type === "number" && typeof value === "number") {
        if (propSchema.minimum !== undefined && value < propSchema.minimum) {
          return { valid: false, error: `Field ${key} must be at least ${propSchema.minimum}` };
        }
        if (propSchema.maximum !== undefined && value > propSchema.maximum) {
          return { valid: false, error: `Field ${key} must be at most ${propSchema.maximum}` };
        }
      }

      if (propSchema.type === "string" && typeof value === "string") {
        if (propSchema.minLength !== undefined && value.length < propSchema.minLength) {
          return {
            valid: false,
            error: `Field ${key} must be at least ${propSchema.minLength} characters`,
          };
        }
        if (propSchema.maxLength !== undefined && value.length > propSchema.maxLength) {
          return {
            valid: false,
            error: `Field ${key} must be at most ${propSchema.maxLength} characters`,
          };
        }
        if (propSchema.pattern && !new RegExp(propSchema.pattern).test(value)) {
          return {
            valid: false,
            error: `Field ${key} does not match required pattern`,
          };
        }
      }
    }
  }

  if (schema.additionalProperties === false) {
    const schemaKeys = schema.properties ? Object.keys(schema.properties) : [];
    const requiredKeys = schema.required || [];
    const allowedKeys = new Set([...schemaKeys, ...requiredKeys]);

    for (const key of Object.keys(obj)) {
      if (!allowedKeys.has(key)) {
        return { valid: false, error: `Unknown field: ${key}` };
      }
    }
  }

  return { valid: true };
}

export function validate(options: ValidatorOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = validateSchema(req.body, options.schema);

    if (!result.valid) {
      const status = 400;
      const error = result.error || "Validation failed";

      if (options.onError) {
        options.onError(res, error, status);
      } else {
        res.status(status).json({ error: "validation_error", message: error });
      }
      return;
    }

    next();
  };
}

export function createValidator(schema: ValidationSchema) {
  return validate({ schema });
}
