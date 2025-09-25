// Transform Plan JSON Schema (draft 2020-12)
// Sourced from spec.md §5; exported for AJV validation.
// Keeping as a plain object to avoid JSON import settings.

export const transformPlanSchema: any = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://json-schema.org/schemas/transform-1.0.json',
  title: 'Transform Plan',
  type: 'object',
  additionalProperties: false,
  properties: {
    atomic: { type: 'boolean', default: false },
    description: { type: 'string' },
    variables: {
      type: 'object',
      additionalProperties: { $ref: '#/$defs/variableSpec' },
    },
    preconditions: { $ref: '#/$defs/jsonSchema' },
    when: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/whenBranch' },
    },
  },
  required: ['when'],
  $defs: {
    jsonSchema: {
      type: 'object',
      description:
        'A JSON Schema fragment to be evaluated against the runtime context object (e.g., { event, state, vars }).',
      examples: [
        {
          properties: {
            event: { properties: { type: { const: 'X' } } },
          },
        },
      ],
    },
    variableSpec: {
      type: 'object',
      additionalProperties: false,
      properties: {
        get: {
          type: 'string',
          description:
            "A pointer expression to resolve a value from the runtime context. See spec prose for allowed expressions (e.g., '/index/{event.id}' or dotted 'event.foo').",
        },
        value: {
          description: "Literal value if present; mutually exclusive with 'get'.",
        },
      },
      oneOf: [
        { required: ['get'], not: { required: ['value'] } },
        { required: ['value'], not: { required: ['get'] } },
      ],
    },
    whenBranch: {
      type: 'object',
      additionalProperties: false,
      properties: {
        if: { $ref: '#/$defs/jsonSchema' },
        then: { $ref: '#/$defs/branchAction' },
        else: { $ref: '#/$defs/branchAction' },
      },
      required: ['if', 'then'],
    },
    branchAction: {
      type: 'object',
      additionalProperties: false,
      properties: {
        preconditions: { $ref: '#/$defs/jsonSchema' },
        variables: {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/variableSpec' },
        },
        ops: {
          type: 'array',
          items: { $ref: '#/$defs/operation' },
        },
      },
      required: ['ops'],
    },
    pathTemplate: {
      type: 'string',
      description:
        "A JSON Pointer-like string which may contain interpolation tokens in the form '{expr}'. Implementations MUST resolve tokens before use.",
    },
    valueSpec: {
      type: ['object', 'string', 'number', 'boolean', 'null', 'array'],
      description:
        'A specification for a value to be used by ops. If an object, it may be a reference form.',
      oneOf: [
        {
          type: 'object',
          properties: {
            valueFrom: {
              type: 'string',
              description:
                "Dotted expression to read from context (e.g., 'event.foo') or a pointer.",
            },
            literal: {},
          },
          additionalProperties: false,
        },
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'null' },
        { type: 'array' },
      ],
    },
    operation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['add', 'replace', 'remove', 'test', 'set'] },
        path: { $ref: '#/$defs/pathTemplate' },
        from: {
          type: 'string',
          description: "RFC 6902 'from' pointer; may contain interpolation tokens.",
        },
        value: { $ref: '#/$defs/valueSpec' },
        testKind: {
          type: 'string',
          enum: ['equality', 'deepEqual'],
          description: "Optional. Specifies how 'test' compares values.",
        },
      },
      allOf: [
        {
          if: { properties: { op: { const: 'remove' } } },
          then: { required: ['path'], not: { required: ['value'] } },
        },
        {
          if: { properties: { op: { const: 'test' } } },
          then: { required: ['path', 'value'] },
        },
        {
          if: { properties: { op: { const: 'add' } } },
          then: { required: ['path', 'value'] },
        },
        {
          if: { properties: { op: { const: 'replace' } } },
          then: { required: ['path', 'value'] },
        },
        {
          if: { properties: { op: { const: 'set' } } },
          then: { required: ['path', 'value'] },
        },
      ],
    },
  },
}

export default transformPlanSchema
