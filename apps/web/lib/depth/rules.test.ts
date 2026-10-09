import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { findDepthViolations } from './rules'

const ROOT = process.cwd()

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue
      out.push(...walk(full))
    } else if (/\.(tsx?|css)$/.test(entry) && !entry.includes('.test.')) out.push(full)
  }
  return out
}

describe('depth rules over the tree', () => {
  const files = ['app', 'components', 'lib'].flatMap((d) => walk(path.join(ROOT, d)))

  it('reads the real tree', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('has no raw shadow, gradient, blur or stray three import', () => {
    const bad = files.flatMap((f) =>
      findDepthViolations(path.relative(ROOT, f).split(path.sep).join('/'), readFileSync(f, 'utf8')),
    )
    expect(bad).toEqual([])
  })
})

describe('findDepthViolations', () => {
  it('catches a raw box-shadow', () => {
    expect(findDepthViolations('components/roles/x.tsx', 'const s = { boxShadow: "0 1px red" }')).toHaveLength(1)
    expect(findDepthViolations('app/x.css', '.a { box-shadow: 0 1px red; }')).toHaveLength(1)
  })
  it('accepts a token shadow and none', () => {
    expect(findDepthViolations('app/x.css', '.a { box-shadow: var(--r-s1); }')).toEqual([])
    expect(findDepthViolations('app/x.css', '.a { box-shadow: none; }')).toEqual([])
  })
  it('catches gradients and blur', () => {
    expect(findDepthViolations('components/roles/x.tsx', '<div className="bg-gradient-to-r" />').length).toBeGreaterThan(0)
    expect(findDepthViolations('components/roles/x.tsx', '<div className="backdrop-blur-md" />')).toHaveLength(1)
    expect(findDepthViolations('app/x.css', '.a { backdrop-filter: blur(4px) }')).toHaveLength(1)
    expect(findDepthViolations('components/roles/x.tsx', '<div className="shadow-[0_2px_red]" />')).toHaveLength(1)
  })
  it('catches three outside components/depth', () => {
    const src = "import * as THREE from 'three'"
    expect(findDepthViolations('components/roles/x.tsx', src)).toHaveLength(1)
    expect(findDepthViolations('components/depth/mark-scene.tsx', src)).toEqual([])
    expect(findDepthViolations('lib/x.ts', "import { Canvas } from '@react-three/fiber'")).toHaveLength(1)
  })
  it('exempts the tokens file', () => {
    expect(
      findDepthViolations('app/relief.css', 'background: linear-gradient(red, blue); box-shadow: 0 1px red'),
    ).toEqual([])
  })
})
