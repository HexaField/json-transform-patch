import { createRequire } from 'node:module'
import * as RFC6902 from 'rfc6902'
import type { Operation } from 'rfc6902'

import schema from './schema.js'

export type Context = {
  event: any
  state: any
  [k: string]: any
}

export type TransformPlan = any

// Minimal ajv-like interfaces to avoid tight typing issues across ESM/NodeNext
export type ValidateFunctionLike = ((data: any) => boolean) & { errors?: unknown }
export type AjvLike = { compile: (schema: any) => ValidateFunctionLike }

export type TransformOptions = { ajv?: AjvLike }

export type TransformResult = {
  state: any
  ops: Operation[]
}

let _ajv: AjvLike | undefined
let _validatePlan: ValidateFunctionLike | undefined

export function getAjv(instance?: AjvLike): AjvLike {
  if (instance) return instance
  if (!_ajv) {
    const require = createRequire(import.meta.url)
    // Use the 2020-12 build which bundles the right meta-schema
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Ajv2020: any = require('ajv/dist/2020')
    _ajv = new Ajv2020({ allErrors: true, strict: false }) as AjvLike
  }
  return _ajv
}

export function validatePlan(plan: TransformPlan, ajv?: AjvLike): { valid: boolean; errors?: unknown } {
  const a = getAjv(ajv)
  if (!_validatePlan) {
    _validatePlan = a.compile(schema)
  }
  const valid = _validatePlan!(plan)
  if (!valid) return { valid: false, errors: _validatePlan!.errors }
  return { valid: true }
}

// Resolve a dotted path like "event.foo.bar" from a context object.
function getByDotted(obj: any, dotted: string): any {
  return dotted.split('.').reduce((acc, seg) => (acc == null ? undefined : acc[seg]), obj)
}

// Interpolate tokens like {event.foo} or {vars.id} into a string
export function interpolate(template: string, context: Record<string, any>): string {
  return template.replace(/\{([^}]+)\}/g, (_, expr) => {
    const val = getByDotted(context, expr.trim())
    if (val == null) return ''
    const s = String(val)
    // RFC6901 escaping for pointer segments occurs later per-segment.
    return s
  })
}

// RFC6901 encode a single path segment
function encodePointerSegment(seg: string): string {
  return seg.replaceAll('~', '~0').replaceAll('/', '~1')
}

// Normalize a possibly templated pointer to a concrete RFC6901 pointer
export function toPointer(pathTemplate: string, ctx: Record<string, any>): string {
  // Replace tokens with RFC6901-encoded segment values
  let out = pathTemplate.replace(/\{([^}]+)\}/g, (_, expr) => {
    const val = getByDotted(ctx, String(expr).trim())
    if (val == null) return ''
    return encodePointerSegment(String(val))
  })
  if (!out.startsWith('/')) out = '/' + out
  return out
}

export type ValueSpec = any

export function resolveValueSpec(spec: ValueSpec, ctx: Record<string, any>) {
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    if ('valueFrom' in spec) {
      return getByDotted(ctx, String(spec.valueFrom))
    }
    if ('literal' in spec) return (spec as any).literal
  }
  return spec
}

export type PreparedOperation = { op: string; path?: string; from?: string; value?: any; originalOp: any }

export function prepareOps(ops: any[], ctx: Record<string, any>): PreparedOperation[] {
  return ops.map((op) => {
    const prepared: PreparedOperation = {
      originalOp: op,
      op: op.op,
      path: op.path ? toPointer(String(op.path), ctx) : (undefined as any),
      from: op.from ? toPointer(String(op.from), ctx) : undefined,
      value: op.value !== undefined ? resolveValueSpec(op.value, ctx) : undefined
    }
    return prepared
  })
}

export function transform(plan: TransformPlan, context: Context, options?: TransformOptions): TransformResult {
  // Validate plan
  const v = validatePlan(plan, options?.ajv)
  if (!v.valid) {
    throw new Error('Invalid TransformPlan: ' + JSON.stringify(v.errors))
  }

  const ajv = getAjv(options?.ajv)
  const compile = (schema: any) => (schema ? ajv.compile(schema) : undefined)

  // base vars
  let vars: Record<string, any> = {}

  const makeCtx = () => ({ ...context, vars })

  // evaluate top-level variables
  if (plan.variables) {
    vars = evalVariables(plan.variables, makeCtx())
  }

  // preconditions
  if (plan.preconditions) {
    const ok = compile(plan.preconditions)!(makeCtx())
    if (!ok) throw new Error('Preconditions failed')
  }

  // branch selection
  const when = plan.when as any[]
  let chosen: any | undefined
  for (const br of when) {
    const match = compile(br.if)!(makeCtx())
    if (match) {
      chosen = br.then
      break
    } else if (br.else) {
      chosen = br.else
      break
    }
  }
  if (!chosen) {
    // If none matched, check for first else in order as per spec "only first matching branch executed"; else if none match & no else, no-ops
    // We'll search for the first branch with an else and take it only if its if evaluated false? Spec says optional else for matched branch; so if nothing matches, do nothing.
    return { state: context.state, ops: [] }
  }

  // Per-branch variables and preconditions
  if (chosen.variables) {
    vars = { ...vars, ...evalVariables(chosen.variables, makeCtx()) }
  }
  if (chosen.preconditions) {
    const ok = compile(chosen.preconditions)!(makeCtx())
    if (!ok) throw new Error('Branch preconditions failed')
  }

  const prepared = prepareOps(chosen.ops ?? [], makeCtx())

  // Apply ops. We need set semantics and atomic behavior.
  // We'll materialize into RFC6902 ops, executing set by checking existence in target state.
  const opsToApply: Operation[] = []
  const snapshot = JSON.parse(JSON.stringify(context.state))
  const existsAt = (obj: any, pointer: string) => {
    const parts = pointer
      .split('/')
      .slice(1)
      .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'))
    let cur = obj
    for (const seg of parts) {
      if (cur == null || !(seg in cur)) return false
      cur = cur[seg]
    }
    return true
  }

  function ensureParentExists(obj: any, pointer: string) {
    const parts = pointer
      .split('/')
      .slice(1)
      .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'))
    const parentParts = parts.slice(0, -1)
    let cur = obj
    for (const seg of parentParts) {
      if (cur[seg] == null) cur[seg] = {}
      if (typeof cur[seg] !== 'object') throw new Error('Cannot create child under non-object at ' + seg)
      cur = cur[seg]
    }
  }

  for (const op of prepared) {
    if (op.op === 'set') {
      const pointer = op.path ?? '/'
      const value = op.value
      // create missing parents for set convenience op
      ensureParentExists(context.state, pointer)
      const exists = existsAt(context.state, pointer)
      opsToApply.push({ op: exists ? 'replace' : 'add', path: pointer, value } as any)
    } else {
      opsToApply.push(op as Operation)
    }
  }

  try {
    const errors = RFC6902.applyPatch(context.state, opsToApply)
    const firstError = errors.find((e) => e)
    if (firstError) throw firstError
    return { state: context.state, ops: opsToApply }
  } catch (e) {
    // rollback if atomic
    if (plan.atomic) {
      // restore snapshot
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(context as any).state = snapshot
    }
    throw e
  }
}

export function evalVariables(variableSpecs: Record<string, any>, ctx: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, spec] of Object.entries(variableSpecs)) {
    if ('value' in spec) out[k] = spec.value
    else if ('get' in spec) {
      // Allow dotted or pointer-like; if starts with '/' treat as pointer template
      const expr = String(spec.get)
      if (expr.startsWith('/')) {
        const pointer = toPointer(expr, ctx)
        out[k] = getByPointer(ctx, pointer)
      } else {
        out[k] = getByDotted(ctx, expr)
      }
    }
  }
  return out
}

function getByPointer(obj: any, pointer: string): any {
  const parts = pointer
    .split('/')
    .slice(1)
    .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'))
  let cur = obj
  for (const seg of parts) {
    if (cur == null) return undefined
    cur = cur[seg]
  }
  return cur
}

export default {
  transform,
  validatePlan,
  prepareOps,
  resolveValueSpec,
  interpolate
}
