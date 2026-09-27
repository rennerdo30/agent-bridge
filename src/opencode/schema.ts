/**
 * Minimal JSON Schema -> zod conversion for the flat object schemas agent-bridge's MCP tools use
 * (strings, numbers, booleans, enums, optional fields). The zod instance is passed in so the
 * opencode plugin can use opencode's own copy.
 */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: JsonSchema[];
}

type Zod = any;

function convert(z: Zod, s: JsonSchema): any {
  let out: any;
  if (Array.isArray(s.enum) && s.enum.every((v) => typeof v === "string") && s.enum.length > 0) {
    out = z.enum(s.enum as [string, ...string[]]);
  } else if (s.anyOf?.length) {
    const opts = s.anyOf.map((x) => convert(z, x));
    out = opts.length === 1 ? opts[0] : z.union(opts);
  } else {
    const type = Array.isArray(s.type) ? s.type[0] : s.type;
    switch (type) {
      case "string":
        out = z.string();
        if (typeof s.minLength === "number") out = out.min(s.minLength);
        if (typeof s.maxLength === "number") out = out.max(s.maxLength);
        break;
      case "integer":
      case "number":
        out = type === "integer" ? z.number().int() : z.number();
        if (typeof s.minimum === "number") out = out.min(s.minimum);
        if (typeof s.maximum === "number") out = out.max(s.maximum);
        break;
      case "boolean":
        out = z.boolean();
        break;
      case "object":
        out = z.object(jsonSchemaToZodShape(z, s));
        break;
      case "array":
        out = z.array(z.any());
        break;
      default:
        out = z.any();
    }
  }
  return s.description ? out.describe(s.description) : out;
}

export function jsonSchemaToZodShape(z: Zod, schema: JsonSchema | undefined): Record<string, any> {
  const shape: Record<string, any> = {};
  const required = new Set(schema?.required ?? []);
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    const field = convert(z, prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}
