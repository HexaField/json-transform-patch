import { describe, expect, it } from 'vitest'

import { interpolate, prepareOps, resolveValueSpec, toPointer, transform, validatePlan } from '../src/index'

describe('API basics', () => {
  it('validates spec examples as valid plans', () => {
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
    const res = validatePlan(plan)
    expect(res.valid).toBe(true)
  })
})

describe('interpolation', () => {
  it('replaces dotted expressions', () => {
    const s = interpolate('/a/{event.x}/b/{vars.id}', { event: { x: '42' }, vars: { id: 'G/1' } })
    expect(s).toBe('/a/42/b/G/1')
  })
  it('encodes pointer segments', () => {
    const p = toPointer('/a/{vars.seg}', { vars: { seg: 'x/y~z' } })
    expect(p).toBe('/a/x~1y~0z')
  })
})

describe('transform execution', () => {
  it('example 6.1 add path using set', () => {
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
        }
      ]
    }
    const ctx = { event: { add: true, groupId: 'G1', itemId: 'I1' }, state: { index: {} } }
    const { state } = transform(plan, ctx)
    expect(state).toEqual({ index: { byGroup: { G1: 'I1' }, byItem: { I1: 'G1' } } })
  })

  it('example 6.1 remove path', () => {
    const plan = {
      atomic: true,
      when: [
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
    const ctx = {
      event: { add: false, groupId: 'G1', itemId: 'I1' },
      state: { index: { byGroup: { G1: 'I1' }, byItem: { I1: 'G1' } } }
    }
    const { state } = transform(plan, ctx)
    expect(state).toEqual({ index: { byGroup: {}, byItem: {} } })
  })

  it('variables and removal (6.2)', () => {
    const plan = {
      atomic: true,
      variables: {
        groupId: { get: '/state/index/byItem/{event.itemId}' }
      },
      when: [
        {
          if: { properties: { state: { required: ['index'] } } },
          then: {
            ops: [
              { op: 'remove', path: '/index/byGroup/{vars.groupId}' },
              { op: 'remove', path: '/index/byItem/{event.itemId}' }
            ]
          }
        }
      ]
    }
    const ctx = { event: { itemId: 'I1' }, state: { index: { byGroup: { G1: 'I1' }, byItem: { I1: 'G1' } } } }
    const { state } = transform(plan, ctx)
    expect(state).toEqual({ index: { byGroup: {}, byItem: {} } })
  })

  it('atomic rollback on error', () => {
    const plan = {
      atomic: true,
      when: [
        {
          if: { properties: { event: { properties: { ok: { const: true } } } } },
          then: {
            ops: [
              { op: 'add', path: '/a', value: 1 },
              // this remove will fail
              { op: 'remove', path: '/missing' }
            ]
          }
        }
      ]
    }
    const ctx = { event: { ok: true }, state: {} }
    expect(() => transform(plan, ctx)).toThrow()
    expect(ctx.state).toEqual({})
  })

  it('else branch executes when if fails', () => {
    const plan = {
      when: [
        {
          if: { properties: { event: { properties: { type: { const: 'NOPE' } } } } },
          then: { ops: [{ op: 'add', path: '/x', value: 1 }] },
          else: { ops: [{ op: 'add', path: '/y', value: 2 }] }
        }
      ]
    }
    const ctx = { event: { type: 'HELLO' }, state: {} }
    const { state } = transform(plan, ctx)
    expect(state).toEqual({ y: 2 })
  })
})

describe('plan validation', () => {
  it('rejects invalid plan (missing when)', () => {
    const bad: any = { atomic: true }
    const res = validatePlan(bad)
    expect(res.valid).toBe(false)
  })

  it('rejects variable with both get and value', () => {
    const bad = {
      when: [{ if: {}, then: { ops: [] } }],
      variables: {
        x: { get: 'event.foo', value: 1 }
      }
    }
    const res = validatePlan(bad)
    expect(res.valid).toBe(false)
  })
})

describe('preconditions', () => {
  it('top-level preconditions abort without mutation', () => {
    const plan = {
      preconditions: { properties: { event: { properties: { ok: { const: true } } } } },
      when: [{ if: {}, then: { ops: [{ op: 'add', path: '/x', value: 1 }] } }]
    }
    const ctx = { event: { ok: false }, state: {} }
    expect(() => transform(plan, ctx)).toThrow()
    expect(ctx.state).toEqual({})
  })

  it('branch preconditions abort branch', () => {
    const plan = {
      when: [
        {
          if: {},
          then: {
            preconditions: { properties: { event: { properties: { ok: { const: true } } } } },
            ops: [{ op: 'add', path: '/x', value: 1 }]
          }
        }
      ]
    }
    const ctx = { event: { ok: false }, state: {} }
    expect(() => transform(plan, ctx)).toThrow()
    expect(ctx.state).toEqual({})
  })
})

describe('variables', () => {
  it('supports value and get (dotted)', () => {
    const plan = {
      variables: { a: { value: 5 }, b: { get: 'event.id' } },
      when: [
        {
          if: {},
          then: {
            ops: [
              { op: 'add', path: '/varsA', value: { valueFrom: 'vars.a' } },
              { op: 'add', path: '/varsB', value: { valueFrom: 'vars.b' } }
            ]
          }
        }
      ]
    }
    const ctx = { event: { id: 'ID1' }, state: {} }
    const { state } = transform(plan, ctx)
    expect(state).toEqual({ varsA: 5, varsB: 'ID1' })
  })

  it('supports pointer-style get with interpolation', () => {
    const plan = {
      variables: { v: { get: '/state/map/{event.key}' } },
      when: [{ if: {}, then: { ops: [{ op: 'add', path: '/out', value: { valueFrom: 'vars.v' } }] } }]
    }
    const ctx = { event: { key: 'k1' }, state: { map: { k1: 42 } } }
    const { state } = transform(plan, ctx)
    expect(state).toEqual({ map: { k1: 42 }, out: 42 })
  })

  it('branch variables override top-level variables of same name', () => {
    const plan = {
      variables: { x: { value: 1 } },
      when: [
        {
          if: {},
          then: { variables: { x: { value: 2 } }, ops: [{ op: 'add', path: '/x', value: { valueFrom: 'vars.x' } }] }
        }
      ]
    }
    const ctx = { event: {}, state: {} }
    const { state } = transform(plan, ctx)
    expect(state).toEqual({ x: 2 })
  })
})

describe('valueSpec', () => {
  it('resolves valueFrom and literal', () => {
    const ctx = { event: { a: 1 }, vars: {} }
    expect(resolveValueSpec({ valueFrom: 'event.a' }, ctx)).toBe(1)
    expect(resolveValueSpec({ literal: 'x' }, ctx)).toBe('x')
    expect(resolveValueSpec(7, ctx)).toBe(7)
  })
})

describe('pointer & interpolation', () => {
  it('encodes tokens safely', () => {
    const ctx = { vars: { seg: 'x/y~z' } }
    const p = toPointer('/root/{vars.seg}/tail', ctx)
    expect(p).toBe('/root/x~1y~0z/tail')
  })

  it('missing token becomes empty segment', () => {
    const ctx = { vars: {} }
    const p = toPointer('/root/{vars.missing}/tail', ctx)
    expect(p).toBe('/root//tail')
  })
})

describe('set semantics', () => {
  it('adds when missing, replaces when exists', () => {
    const plan = {
      when: [
        {
          if: {},
          then: {
            ops: [
              { op: 'set', path: '/a/b', value: 1 },
              { op: 'set', path: '/a/b', value: 2 }
            ]
          }
        }
      ]
    }
    const ctx = { event: {}, state: {} }
    const { state } = transform(plan, ctx)
    expect(state).toEqual({ a: { b: 2 } })
  })

  it('throws when parent is non-object and atomic rollback occurs', () => {
    const plan = { atomic: true, when: [{ if: {}, then: { ops: [{ op: 'set', path: '/a/b', value: 1 }] } }] }
    const ctx = { event: {}, state: { a: 5 } }
    expect(() => transform(plan, ctx)).toThrow()
    expect(ctx.state).toEqual({ a: 5 })
  })
})

describe('atomic vs non-atomic failure behavior', () => {
  it('non-atomic keeps earlier ops on failure', () => {
    const plan = {
      atomic: false,
      when: [
        {
          if: {},
          then: {
            ops: [
              { op: 'add', path: '/x', value: 1 },
              { op: 'remove', path: '/missing' } // fail
            ]
          }
        }
      ]
    }
    const ctx = { event: {}, state: {} }
    expect(() => transform(plan, ctx)).toThrow()
    expect(ctx.state).toEqual({ x: 1 })
  })

  it('test op failure rolls back when atomic', () => {
    const plan = {
      atomic: true,
      when: [
        {
          if: {},
          then: {
            ops: [
              { op: 'add', path: '/x', value: 1 },
              { op: 'test', path: '/x', value: 2 }
            ]
          }
        }
      ]
    }
    const ctx = { event: {}, state: {} }
    expect(() => transform(plan, ctx)).toThrow()
    expect(ctx.state).toEqual({})
  })
})

describe('branch selection', () => {
  it('only first matching branch runs', () => {
    const plan = {
      when: [
        {
          if: { properties: { event: { properties: { t: { const: true } } } } },
          then: { ops: [{ op: 'add', path: '/x', value: 1 }] }
        },
        { if: {}, then: { ops: [{ op: 'add', path: '/y', value: 2 }] } }
      ]
    }
    const ctx = { event: { t: true }, state: {} }
    const { state } = transform(plan, ctx)
    expect(state).toEqual({ x: 1 })
  })

  it('no match and no else yields no-ops', () => {
    const plan = {
      when: [
        {
          if: { properties: { event: { properties: { t: { const: true } } } } },
          then: { ops: [{ op: 'add', path: '/x', value: 1 }] }
        }
      ]
    }
    const ctx = { event: { t: false }, state: {} }
    const { state, ops } = transform(plan, ctx)
    expect(ops).toEqual([])
    expect(state).toEqual({})
  })
})
