/**
 * 测试用的最小 JSON Schema 校验器(项目没有 ajv,不为了测试再装一个包)。
 * 只支持 shared/schema/document-v2.schema.json 用到的子集:
 * type(单个或数组)、enum(含 null)、properties / required / additionalProperties(false | true)、items、minimum / maximum、
 * maxLength / maxItems、pattern、oneOf、$ref(只认 #/$defs/...)。遇到不认识的关键字直接抛错,免得悄悄放过。
 */
type Schema = Record<string, unknown>
const KNOWN = new Set([
  '$schema', '$id', 'title', 'description', 'type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minimum', 'maximum',
  'maxLength', 'maxItems', 'pattern', 'oneOf', 'anyOf', '$ref', '$defs',
])

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
const typeOk = (want: string, v: unknown) => (want === 'number' ? typeof v === 'number' && Number.isFinite(v) : want === 'integer' ? Number.isInteger(v) : typeOf(v) === want)

export function validate(root: Schema, value: unknown): string[] {
  const errors: string[] = []
  const walk = (schema: Schema, v: unknown, path: string): void => {
    for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`jsonschema helper: unsupported keyword "${k}" at ${path || '/'}`)
    if (typeof schema.$ref === 'string') {
      const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref)
      const target = m && ((root.$defs as Record<string, Schema> | undefined)?.[m[1]!])
      if (!target) throw new Error(`jsonschema helper: unresolved $ref ${schema.$ref}`)
      return walk(target, v, path)
    }
    if (schema.oneOf) {
      const alts = schema.oneOf as Schema[]
      const hits = alts.filter((a) => { const before = errors.length; walk(a, v, path); const ok = errors.length === before; errors.length = before; return ok }).length
      if (hits !== 1) errors.push(`${path || '/'}: matches ${hits} of oneOf (expected exactly 1)`)
      return
    }
    if (schema.anyOf) {
      const alts = schema.anyOf as Schema[]
      const hits = alts.filter((a) => { const before = errors.length; walk(a, v, path); const ok = errors.length === before; errors.length = before; return ok }).length
      if (hits < 1) errors.push(`${path || '/'}: matches none of anyOf`)
      return
    }
    if (schema.enum && !(schema.enum as unknown[]).includes(v)) { errors.push(`${path || '/'}: ${JSON.stringify(v)} not in enum`); return }
    if (schema.type !== undefined) {
      const want = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]
      if (!want.some((w) => typeOk(w, v))) { errors.push(`${path || '/'}: expected ${want.join('|')}, got ${typeOf(v)}`); return }
    }
    if (typeof v === 'number') {
      if (typeof schema.minimum === 'number' && v < schema.minimum) errors.push(`${path}: ${v} < minimum ${schema.minimum}`)
      if (typeof schema.maximum === 'number' && v > schema.maximum) errors.push(`${path}: ${v} > maximum ${schema.maximum}`)
    }
    if (typeof v === 'string') {
      if (typeof schema.maxLength === 'number' && v.length > schema.maxLength) errors.push(`${path}: length ${v.length} > ${schema.maxLength}`)
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(v)) errors.push(`${path}: "${v}" does not match ${schema.pattern}`)
    }
    if (Array.isArray(v)) {
      if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) errors.push(`${path}: ${v.length} items > ${schema.maxItems}`)
      if (schema.items) v.forEach((x, i) => walk(schema.items as Schema, x, `${path}[${i}]`))
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      const props = (schema.properties ?? {}) as Record<string, Schema>
      for (const r of (schema.required ?? []) as string[]) if (!(r in o)) errors.push(`${path}/${r}: required`)
      for (const [k, x] of Object.entries(o)) {
        if (props[k]) walk(props[k]!, x, `${path}/${k}`)
        else if (schema.additionalProperties === false) errors.push(`${path}/${k}: unexpected property`)
      }
    }
  }
  walk(root, value, '')
  return errors
}
