# @hexafield/json-transform

A tiny, stateless library to execute declarative JSON Transform Plans against a `{ event, state }` context using:

- JSON Schema (AJV) for plan validation and conditional branching
- RFC 6902 JSON Patch for mutation semantics

Implements the Transform Plan schema described in `spec.md` and provides a small functional API.

## Install

```sh
npm install @hexafield/json-transform
```

## Quick start

```ts
import { transform, validatePlan } from '@hexafield/json-transform'

const plan = {
  atomic: true,
  when: [
    {
      if: { properties: { event: { properties: { add: { const: true } } } } },
      then: {
        ops: [
          { op: 'set', path: '/index/byGroup/{event.groupId}', value: { valueFrom: 'event.itemId' } },
          { op: 'set', path: '/index/byItem/{event.itemId}', value: { valueFrom: 'event.groupId' } }
        ]
      }
    },
    {
      if: { properties: { event: { properties: { add: { const: false } } } } },
      then: {
        ops: [
          { op: 'remove', path: '/index/byGroup/{event.groupId}' },
          { op: 'remove', path: '/index/byItem/{event.itemId}' }
        ]
      }
    }
  ]
}

const ctx = { event: { add: true, groupId: 'G1', itemId: 'I1' }, state: { index: {} } }

const { valid, errors } = validatePlan(plan)
if (!valid) throw new Error('Invalid plan: ' + JSON.stringify(errors))

const result = transform(plan, ctx)
console.log(result.state)
// => { index: { byGroup: { G1: 'I1' }, byItem: { I1: 'G1' } } }
```

## API

- `validatePlan(plan, options?) => { valid: boolean; errors?: unknown }`
  - Validates a Transform Plan against the bundled JSON Schema (draft 2020-12) using AJV.
  - `options.ajv` may pass a custom Ajv instance (must be draft-2020 capable).

- `transform(plan, context, options?) => { state, ops }`
  - Evaluates variables, preconditions, and selects the first matching `when` branch (or its `else`).
  - Interpolates `{...}` expressions in `path` and resolves `valueFrom`.
  - Maps `set` to `add` or `replace` depending on target existence (and creates missing parent objects).
  - Applies ops via RFC 6902 JSON Patch; if `atomic: true`, any error rolls changes back.

- `prepareOps(ops, ctx) => Operation[]`
  - Resolves interpolation and values into RFC 6902 operations (with `set` preserved as convenience before mapping).

- `interpolate(template, ctx) => string`
  - Replaces `{event.foo}`, `{state.bar}`, `{vars.id}` in strings.

- `resolveValueSpec(spec, ctx)`
  - Resolves `{ valueFrom: 'dotted.path' }` or `{ literal: any }`, otherwise returns the value unchanged.

## Transform Plan Model (summary)

See `spec.md` for the full schema and semantics. Highlights:

- `atomic` — apply all ops as a transaction (best-effort rollback on failure).
- `variables` — computed values available as `{vars.name}`.
- `preconditions` — JSON Schema predicate on `{ event, state, vars }`.
- `when` — ordered branches with `if` (JSON Schema) and `then`/`else` actions.
- `ops` — array of JSON Patch-like operations plus `set`.

Supported ops: `add`, `replace`, `remove`, `test`, `set`.

Interpolation tokens inside `path` are RFC6901-safe (segments encoded with `~0`/`~1`).

## Development

- Build: `npm run build`
- Test: `npm run test` or `npx vitest`

## Security Notes

- Interpolation is sanitized for JSON Pointer segments to avoid pointer injection.
- Consider bounding plan complexity and predicate evaluation time in hosting runtimes.

## License

MIT
