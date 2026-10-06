import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REGISTER } from './register'

const migration = readFileSync(path.resolve(__dirname, '../../../../supabase/migrations/20261008045000_measures_seed.sql'), 'utf8')

const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

describe('the register', () => {
  it('holds every measure of 13.1: T1 to T33, S1 to S26, P1 to P9, once each', () => {
    expect(REGISTER.map((m) => m.id)).toEqual([...range('T', 33), ...range('S', 26), ...range('P', 9)])
  })

  it('gives every measure a layer that matches its id, a name, a bar and a place its number comes from', () => {
    for (const m of REGISTER) {
      expect(m.layer, m.id).toBe(m.id[0] === 'T' ? 'true' : m.id[0] === 'S' ? 'step' : 'person')
      expect(m.name.length, m.id).toBeGreaterThan(5)
      expect(m.bar.length, m.id).toBeGreaterThan(0)
      expect(m.source.length, m.id).toBeGreaterThan(0)
      expect(m.name + m.bar, m.id).not.toMatch(/—|!/)
    }
  })

  it('names the packages each measure gates, as package ids', () => {
    for (const m of REGISTER) for (const g of m.gates) expect(g, m.id).toMatch(/^(K\d+[a-z]?|PG\d+|SP\d+)$/)
    expect(REGISTER.find((m) => m.id === 'T5')?.gates).toEqual(['K4'])
    expect(REGISTER.find((m) => m.id === 'S2')?.gates).toEqual(['K5c', 'K15b'])
  })

  it('is exactly what the seed migration inserts', () => {
    const rows: { id: string; layer: string; name: string; bar: string; direction: string; source: string; gates: string[] }[] = []
    const line = /^ {2}\('(\w+)', '(true|step|person)', '((?:[^']|'')*)', '((?:[^']|'')*)', '(\w+)', '((?:[^']|'')*)', (array\[[^\]]*\]::text\[\]|'\{\}'::text\[\])\)[,]?$/gm
    for (const m of migration.matchAll(line)) {
      const unq = (s: string) => s.replace(/''/g, "'")
      rows.push({
        id: m[1],
        layer: m[2],
        name: unq(m[3]),
        bar: unq(m[4]),
        direction: m[5],
        source: unq(m[6]),
        gates: [...m[7].matchAll(/'(\w+)'/g)].map((g) => g[1]),
      })
    }
    expect(rows).toEqual(REGISTER.map((m) => ({ id: m.id, layer: m.layer, name: m.name, bar: m.bar, direction: m.direction, source: m.source, gates: m.gates })))
  })

  it('seeds every row as watch and never overwrites a row a package has flipped', () => {
    expect(migration).toContain('on conflict (id) do nothing')
    expect(migration).not.toMatch(/'gating'/)
  })
})
