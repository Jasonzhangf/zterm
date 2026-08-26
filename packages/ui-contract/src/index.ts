export type SurfaceId = string;
export type CapabilityId = string;

export interface ClientAction<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
}

export interface UiContribution {
  readonly surfaceId: SurfaceId;
  readonly route: string;
  readonly viewModelSchema: string;
}

export interface UiPluginManifest {
  readonly pluginId: string;
  readonly requires: readonly CapabilityId[];
  readonly contributes: readonly UiContribution[];
}

interface JsonObjectSchema {
  readonly type: 'object';
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
}

interface JsonArraySchema {
  readonly type: 'array';
  readonly items?: JsonSchema;
}

interface JsonStringSchema { readonly type: 'string'; }
interface JsonNumberSchema { readonly type: 'number' | 'integer'; }
interface JsonBooleanSchema { readonly type: 'boolean'; }
interface JsonNullSchema { readonly type: 'null'; }

export type JsonSchema =
  | JsonObjectSchema
  | JsonArraySchema
  | JsonStringSchema
  | JsonNumberSchema
  | JsonBooleanSchema
  | JsonNullSchema;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function primitiveMatches(
  schema: JsonStringSchema | JsonNumberSchema | JsonBooleanSchema | JsonNullSchema,
  value: unknown,
): boolean {
  switch (schema.type) {
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number';
  }
}

export function validateUiViewModel(
  schema: JsonSchema,
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(schema) || typeof schema.type !== 'string') {
    return { ok: false, reason: 'schema.type must be a string' };
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return { ok: false, reason: 'expected array' };
    for (const [index, item] of value.entries()) {
      const items = (schema as JsonArraySchema).items;
      if (items) {
        const result = validateUiViewModel(items, item);
        if (!result.ok) return { ok: false, reason: `[${index}]: ${result.reason}` };
      }
    }
    return { ok: true };
  }
  if (schema.type === 'object') {
    if (!isRecord(value)) return { ok: false, reason: 'expected object' };
    for (const key of schema.required ?? []) {
      if (!(key in value)) return { ok: false, reason: `missing required property: ${key}` };
    }
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        const result = validateUiViewModel(property, value[key]);
        if (!result.ok) return { ok: false, reason: `${key}: ${result.reason}` };
      }
    }
    return { ok: true };
  }
  const primitive = schema as JsonStringSchema | JsonNumberSchema | JsonBooleanSchema | JsonNullSchema;
  return primitiveMatches(primitive, value)
    ? { ok: true }
    : { ok: false, reason: `expected ${primitive.type}` };
}

export function validateUiPluginManifest(
  value: unknown,
): { ok: true; manifest: UiPluginManifest } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: 'manifest must be an object' };
  const manifest = value as Partial<UiPluginManifest>;
  if (typeof manifest.pluginId !== 'string' || manifest.pluginId.trim() === '') {
    return { ok: false, reason: 'pluginId must be non-empty string' };
  }
  if (!Array.isArray(manifest.requires) || !manifest.requires.every(
    (id): id is CapabilityId => typeof id === 'string' && id.trim().length > 0,
  )) {
    return { ok: false, reason: 'requires entries must be non-empty capability ids' };
  }
  if (!Array.isArray(manifest.contributes)) return { ok: false, reason: 'contributes must be array' };
  const surfaces = new Set<SurfaceId>();
  for (const contribution of manifest.contributes) {
    if (!isRecord(contribution)) return { ok: false, reason: 'contribution must be object' };
    if (typeof contribution.surfaceId !== 'string' || contribution.surfaceId.trim() === '') {
      return { ok: false, reason: 'surfaceId must be non-empty string' };
    }
    if (typeof contribution.route !== 'string' || !contribution.route.startsWith('/')) {
      return { ok: false, reason: `route must start with /: ${contribution.route}` };
    }
    if (typeof contribution.viewModelSchema !== 'string' || contribution.viewModelSchema.trim() === '') {
      return { ok: false, reason: 'viewModelSchema must be non-empty string' };
    }
    if (surfaces.has(contribution.surfaceId)) {
      return { ok: false, reason: `duplicate surfaceId: ${contribution.surfaceId}` };
    }
    surfaces.add(contribution.surfaceId);
  }
  return { ok: true, manifest: value as unknown as UiPluginManifest };
}
