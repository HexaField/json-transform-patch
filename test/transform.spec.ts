import { describe, expect, it } from 'vitest'
import { interpolate, prepareOps, toPointer, transform, validatePlan } from '../src/index'

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
              { op: 'set', path: '/index/byItem/{event.itemId}', value: { valueFrom: 'event.groupId' } },
            ],
          },
        },
        {
          if: { properties: { event: { properties: { add: { const: false } } } } },
          then: {
            ops: [
              { op: 'remove', path: '/index/byGroup/{event.groupId}' },
              { op: 'remove', path: '/index/byItem/{event.itemId}' },
            ],
          },
        },
      ],
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
              { op: 'set', path: '/index/byItem/{event.itemId}', value: { valueFrom: 'event.groupId' } },
            ],
          },
        },
      ],
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
          then: { ops: [
            { op: 'remove', path: '/index/byGroup/{event.groupId}' },
            { op: 'remove', path: '/index/byItem/{event.itemId}' },
          ] },
        },
      ],
    }
    const ctx = { event: { add: false, groupId: 'G1', itemId: 'I1' }, state: { index: { byGroup: { G1: 'I1' }, byItem: { I1: 'G1' } } } }
    const { state } = transform(plan, ctx)
    expect(state).toEqual({ index: { byGroup: {}, byItem: {} } })
  })

  it('variables and removal (6.2)', () => {
    const plan = {
      atomic: true,
      variables: {
        groupId: { get: '/state/index/byItem/{event.itemId}' },
      },
      when: [
        {
          if: { properties: { state: { required: ['index'] } } },
          then: {
            ops: [
              { op: 'remove', path: '/index/byGroup/{vars.groupId}' },
              { op: 'remove', path: '/index/byItem/{event.itemId}' },
            ],
          },
        },
      ],
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
              { op: 'remove', path: '/missing' },
            ],
          },
        },
      ],
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
          else: { ops: [{ op: 'add', path: '/y', value: 2 }] },
        },
      ],
    }
    const ctx = { event: { type: 'HELLO' }, state: {} }
    const { state } = transform(plan, ctx)
    expect(state).toEqual({ y: 2 })
  })
})
