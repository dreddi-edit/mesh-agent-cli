export interface ToolInputValidationResult {
  args: Record<string, unknown>;
  warnings: string[];
}

export class ToolInputValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly issues: string[]
  ) {
    super(`Invalid input for ${toolName}: ${issues.join("; ")}`);
    this.name = "ToolInputValidationError";
  }
}

type JsonSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
};

export function validateToolInput(
  toolName: string,
  args: Record<string, unknown> | undefined,
  schema: unknown
): ToolInputValidationResult {
  if (!isSchema(schema)) {
    return { args: args ?? {}, warnings: [] };
  }

  const input = isPlainObject(args) ? args : {};
  const issues: string[] = [];
  const warnings: string[] = [];
  const value = validateValue(input, schema, toolName, issues, warnings);

  if (issues.length > 0) {
    throw new ToolInputValidationError(toolName, issues);
  }

  return {
    args: isPlainObject(value) ? value : {},
    warnings
  };
}

function validateValue(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: string[],
  warnings: string[]
): unknown {
  if (value === undefined && Object.prototype.hasOwnProperty.call(schema, "default")) {
    return cloneJsonValue(schema.default);
  }

  if (value === undefined) {
    return undefined;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    issues.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
    return value;
  }

  switch (schema.type) {
    case "object":
      return validateObject(value, schema, path, issues, warnings);
    case "array":
      return validateArray(value, schema, path, issues, warnings);
    case "string":
      if (typeof value !== "string") issues.push(`${path} must be a string`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) issues.push(`${path} must be a finite number`);
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) issues.push(`${path} must be an integer`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") issues.push(`${path} must be a boolean`);
      return value;
    case undefined:
      return value;
    default:
      warnings.push(`${path} uses unsupported schema type '${schema.type}'`);
      return value;
  }
}

function validateObject(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: string[],
  warnings: string[]
): unknown {
  if (!isPlainObject(value)) {
    issues.push(`${path} must be an object`);
    return value;
  }

  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const result: Record<string, unknown> = { ...value };

  for (const key of required) {
    if (result[key] === undefined) {
      issues.push(`${path}.${key} is required`);
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    const next = validateValue(result[key], propertySchema, `${path}.${key}`, issues, warnings);
    if (next !== undefined || Object.prototype.hasOwnProperty.call(propertySchema, "default")) {
      result[key] = next;
    }
  }

  for (const key of Object.keys(result)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      warnings.push(`${path}.${key} is not declared in inputSchema`);
    }
  }

  return result;
}

function validateArray(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: string[],
  warnings: string[]
): unknown {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return value;
  }

  if (!schema.items) {
    return value;
  }

  return value.map((item, index) => validateValue(item, schema.items as JsonSchema, `${path}[${index}]`, issues, warnings));
}

function isSchema(value: unknown): value is JsonSchema {
  return isPlainObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}
