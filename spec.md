# Transformation Plan Schema — Internet-Draft (Informational)

```
Transform Plan Schema
draft-irtf-transform-00
September 2025
```

## Abstract

This document specifies a JSON Schema vocabulary and canonical JSON Schema document for a declarative **Transformation Plan** (the “Transform Plan”). A Transform Plan is a serializable description of conditional, atomic, and composable transformations to be applied to a JSON state document in response to an event. Transform Plans are intended to be used together with JSON Schema–based validation of `{ event, state }` contexts and with RFC 6902 JSON Patch semantics extended for dynamic path and value interpolation.

This document provides a machine-readable JSON Schema (draft 2020-12) describing the structure and allowed constructs of a Transform Plan, and normative prose describing semantics and runtime expectations.

> **Note:** This document defines only the Transform Plan data model and the JSON Schema that validates it. It does **not** define an execution engine or a wire protocol.

---

## 1. Terminology

Words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, and **MAY** are to be interpreted as described in [RFC 2119](https://tools.ietf.org/html/rfc2119).

- **Context** — a JSON object with two top-level properties: `event` (the incoming payload) and `state` (the mutable state document to be transformed). Runtimes MAY include additional context such as `now` or `principal`.
- **Interpolation token** — a `{...}` token appearing inside a `path` or string where values are substituted by evaluating an expression against the available `context` (see §3.3).
- **Atomic** — when a Transform Plan is marked `atomic: true`, the runtime SHALL apply all operations as a single logical transaction: either all operations succeed, or none take effect. The exact transactional semantics are runtime-dependent.
- **Op** — a single operation in the plan (set/add/replace/remove/test). Ops are aligned with RFC 6902 semantics except for the additional `set` convenience and dynamic interpolation features.

---

## 2. Design Goals

- **Serializable**: The Transform Plan is pure JSON and can be stored, transmitted, and inspected.
- **Composable**: Branches and variables let plans express complex conditional flows without bespoke code.
- **Safe**: Support for `preconditions` and `test` operations enables optimistic concurrency and guarded updates.
- **Interoperable**: The plan maps naturally to JSON Patch semantics and JSON Schema-based predicate expressions.

---

## 3. Runtime semantics (informative)

The JSON Schema provided in §5 constrains the structure of a Transform Plan. Implementations of runtimes that accept Transform Plans **SHOULD** obey the following semantics:

### 3.1 High-level flow

1. Validate the plan itself against the Transform Plan Schema.
2. Evaluate any `validate` schema (if present) against the runtime `context` (where the runtime may validate `{ event, state }`).
3. Evaluate `variables` (if present) to produce a `vars` map derivable from `context` (see §3.2).
4. Evaluate `preconditions` (if present) against `{ event, state, vars }`; failure aborts the plan with no state mutation.
5. Evaluate `when` branches in order. For each branch:

   - Evaluate the branch `if` predicate (a JSON Schema fragment applied to `{ event, state, vars }`).
   - If the predicate matches, evaluate associated `then` (and optional `else`) actions; only the first matching branch is executed unless implementations explicitly support multiple-match semantics.

6. Collect the sequence of `ops` produced by executed branches, resolve interpolation tokens, and apply them atomically if `atomic: true` (or sequentially otherwise).
7. Return the modified state document or an error indicating which op failed and why.

### 3.2 Variables

- `variables` are named expressions evaluated before branch selection. Each variable value is derived by evaluating a `get` expression (a JSON Pointer or JSONPath-like expression) against `{ event, state, vars }` or by resolving a literal.
- Variables can be referenced in `path` templates and `value` specs as `{vars.name}`.

### 3.3 Interpolation

- Interpolation tokens inside `path` and string `value` fields use the grammar `{ <expression> }` where `<expression>` is a simple dotted-access expression such as `event.foo`, `state.maps.m1`, or `vars.groupId`.
- Runtimes MUST resolve tokens before applying operations and MUST percent-encode or reject tokens that would produce invalid JSON Pointer segments. The canonical decoding rule is left to the implementation; however, implementations SHOULD follow RFC 6901 for pointer semantics after substitution.

### 3.4 Ops and failure semantics

- Supported `op` types: `add`, `replace`, `remove`, `test`, `set`.

  - `set` is a convenience that behaves like `add` if the target does not exist, or `replace` if it does.

- `test` must validate that the value at `path` equals the resolved `value`; failure of a `test` causes the entire plan to abort without applying further ops.
- If `atomic: true`, any failure during application must cause the runtime to roll back all prior operations attempted by the plan.
- The positional order of ops is significant.

---

## 4. Schema-level constraints (summary)

- `atomic` — boolean, defaults to `false`.
- `variables` — optional object; each property is a `VariableSpec`.
- `preconditions` — optional JSON Schema object evaluated against `{ event, state, vars }`.
- `when` — required non-empty array of `WhenBranch` objects.
- Each `WhenBranch`:

  - `if` — required JSON Schema fragment.
  - `then` — required object with an `ops` array; may include `preconditions` and `variables`.
  - `else` — optional object with `ops`.

- `ops` — array of `Operation` objects.

---

## 5. Transform Plan JSON Schema (draft 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://json-schema.org/schemas/transform-1.0.json",
  "title": "Transform Plan",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "atomic": { "type": "boolean", "default": false },
    "description": { "type": "string" },
    "variables": {
      "type": "object",
      "additionalProperties": { "$ref": "#/$defs/variableSpec" }
    },
    "preconditions": { "$ref": "#/$defs/jsonSchema" },
    "when": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/whenBranch" }
    }
  },
  "required": ["when"],
  "$defs": {
    "jsonSchema": {
      "type": "object",
      "description": "A JSON Schema fragment to be evaluated against the runtime context object (e.g., { event, state, vars }).",
      "examples": [
        {
          "properties": {
            "event": { "properties": { "type": { "const": "X" } } }
          }
        }
      ]
    },

    "variableSpec": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "get": {
          "type": "string",
          "description": "A pointer expression to resolve a value from the runtime context. See spec prose for allowed expressions (e.g., '/index/{event.id}' or dotted 'event.foo')."
        },
        "value": {
          "description": "Literal value if present; mutually exclusive with 'get'."
        }
      },
      "oneOf": [
        { "required": ["get"], "not": { "required": ["value"] } },
        { "required": ["value"], "not": { "required": ["get"] } }
      ]
    },

    "whenBranch": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "if": { "$ref": "#/$defs/jsonSchema" },
        "then": { "$ref": "#/$defs/branchAction" },
        "else": { "$ref": "#/$defs/branchAction" }
      },
      "required": ["if", "then"]
    },

    "branchAction": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "preconditions": { "$ref": "#/$defs/jsonSchema" },
        "variables": {
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/variableSpec" }
        },
        "ops": {
          "type": "array",
          "items": { "$ref": "#/$defs/operation" }
        }
      },
      "required": ["ops"]
    },

    "pathTemplate": {
      "type": "string",
      "description": "A JSON Pointer-like string which may contain interpolation tokens in the form '{expr}'. Implementations MUST resolve tokens before use."
    },

    "valueSpec": {
      "type": ["object", "string", "number", "boolean", "null", "array"],
      "description": "A specification for a value to be used by ops. If an object, it may be a reference form.",
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "valueFrom": {
              "type": "string",
              "description": "Dotted expression to read from context (e.g., 'event.foo') or a pointer."
            },
            "literal": {}
          },
          "additionalProperties": false
        },
        { "type": "string" },
        { "type": "number" },
        { "type": "boolean" },
        { "type": "null" },
        { "type": "array" }
      ]
    },

    "operation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "op": {
          "type": "string",
          "enum": ["add", "replace", "remove", "test", "set"]
        },
        "path": { "$ref": "#/$defs/pathTemplate" },
        "from": {
          "type": "string",
          "description": "RFC 6902 'from' pointer; may contain interpolation tokens."
        },
        "value": { "$ref": "#/$defs/valueSpec" },
        "testKind": {
          "type": "string",
          "enum": ["equality", "deepEqual"],
          "description": "Optional. Specifies how 'test' compares values."
        }
      },
      "allOf": [
        {
          "if": { "properties": { "op": { "const": "remove" } } },
          "then": { "required": ["path"], "not": { "required": ["value"] } }
        },
        {
          "if": { "properties": { "op": { "const": "test" } } },
          "then": { "required": ["path", "value"] }
        },
        {
          "if": { "properties": { "op": { "const": "add" } } },
          "then": { "required": ["path", "value"] }
        },
        {
          "if": { "properties": { "op": { "const": "replace" } } },
          "then": { "required": ["path", "value"] }
        },
        {
          "if": { "properties": { "op": { "const": "set" } } },
          "then": { "required": ["path", "value"] }
        }
      ]
    }
  }
}
```

---

## 6. Examples (informative)

### 6.1 Toggle membership in simple indexes (short form)

```json
{
  "atomic": true,
  "when": [
    {
      "if": {
        "properties": {
          "event": { "properties": { "add": { "const": true } } }
        }
      },
      "then": {
        "ops": [
          {
            "op": "set",
            "path": "/index/byGroup/{event.groupId}",
            "value": { "valueFrom": "event.itemId" }
          },
          {
            "op": "set",
            "path": "/index/byItem/{event.itemId}",
            "value": { "valueFrom": "event.groupId" }
          }
        ]
      }
    },
    {
      "if": {
        "properties": {
          "event": { "properties": { "add": { "const": false } } }
        }
      },
      "then": {
        "ops": [
          { "op": "remove", "path": "/index/byGroup/{event.groupId}" },
          { "op": "remove", "path": "/index/byItem/{event.itemId}" }
        ]
      }
    }
  ]
}
```

### 6.2 Remove related entries using a variable

```json
{
  "atomic": true,
  "variables": {
    "groupId": { "get": "/index/byItem/{event.itemId}" }
  },
  "when": [
    {
      "if": {
        "$ref": "#/$defs/jsonSchema",
        "properties": { "state": { "required": ["index"] } }
      },
      "then": {
        "ops": [
          { "op": "remove", "path": "/index/byGroup/{vars.groupId}" },
          { "op": "remove", "path": "/index/byItem/{event.itemId}" }
        ]
      }
    }
  ]
}
```

---

## 7. Security Considerations

- **Injection risks**: allowing free-form interpolation creates a risk if interpolated values contain characters that alter pointer semantics. Runtimes MUST sanitize or validate interpolated segments to prevent pointer traversal or injection attacks.
- **Denial-of-Service**: overly complex `when` predicates or very large `ops` arrays could be used to induce heavy computation. Runtimes SHOULD bound execution time, recursion, and resource usage.
- **Confidentiality**: Transform Plans may reference sensitive data via `valueFrom` or `get`. Transport and storage of Transform Plans SHOULD follow best practices for confidentiality (TLS, encryption-at-rest) when sensitive fields are present.

---

## 8. IANA Considerations

This document does not request IANA actions.

---

## 9. References

- JSON Schema Core and Validation — Internet Draft / JSON Schema organization (draft 2020-12).
- RFC 6902 — JavaScript Object Notation (JSON) Patch.

---

## 10. Acknowledgements

The Transform Plan schema and semantics are inspired by practical patterns for event-driven state mutation and policy-driven mutation systems (e.g., mutating admission controllers and rule engines). The schema is intentionally minimal to serve as a foundation for extension.

---

## Authors' Addresses

- Spec author: (your name or placeholder)
- Contact: (email or placeholder)

---

### Implementation note (informative)

Runtimes that adopt this schema will often need to:

1. Compile and cache JSON Schema predicates (`if`, `preconditions`, etc.) using a JSON Schema engine (e.g., AJV).
2. Implement an expression resolver for interpolation tokens and `get` expressions; pick or document a clear evaluation language (JSON Pointer with `{}` tokens, or JSONPath).
3. Map `set` to `add/replace` semantics in RFC 6902–compatible patch application libraries and provide rollback semantics when `atomic: true`.

---

_End of document._
