'use client'

// Cello's mark as an object: a dark bevelled rounded tile with the petrol
// spiral standing on it, lit from the upper left (the same light as the CSS),
// a rim light from the upper right and a cool fill. Only named imports from
// three, no drei. The tile colour reads --r-mark so it stays the darkest
// object in either appearance.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Color, CubicBezierCurve3, CurvePath, ExtrudeGeometry, Shape, TubeGeometry, Vector3 } from 'three'
import type { Group } from 'three'
import type { StillName } from '@/components/ui/contract'

/** The rest pose: turned and tilted so the bevel and the right side catch the light. */
export const REST = { x: -0.16, y: 0.25 }

// The spiral's five cubic segments, in the logo's 64 unit space.
const SEGMENTS = [
  [50, 47, 44, 56, 30, 58, 20, 51],
  [20, 51, 9, 43, 8, 26, 19, 17],
  [19, 17, 30, 8, 46, 12, 51, 23],
  [51, 23, 55, 32, 49, 41, 40, 41],
  [40, 41, 33, 41, 29, 35, 32, 29],
]

const toPoint = (x: number, y: number) => new Vector3(((x - 32) / 32) * 0.78, (-(y - 32) / 32) * 0.78, 0)

function makeTile(): ExtrudeGeometry {
  const r = 0.47
  const w = 1
  const s = new Shape()
  s.moveTo(-w + r, -w)
  s.lineTo(w - r, -w)
  s.quadraticCurveTo(w, -w, w, -w + r)
  s.lineTo(w, w - r)
  s.quadraticCurveTo(w, w, w - r, w)
  s.lineTo(-w + r, w)
  s.quadraticCurveTo(-w, w, -w, w - r)
  s.lineTo(-w, -w + r)
  s.quadraticCurveTo(-w, -w, -w + r, -w)
  const g = new ExtrudeGeometry(s, {
    depth: 0.6,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.1,
    bevelSegments: 5,
    curveSegments: 10,
  })
  g.translate(0, 0, -0.6)
  return g
}

function makeSpiral(): TubeGeometry {
  const path = new CurvePath<Vector3>()
  for (const [a, b, c, d, e, f, g, h] of SEGMENTS) {
    path.add(new CubicBezierCurve3(toPoint(a, b), toPoint(c, d), toPoint(e, f), toPoint(g, h)))
  }
  const g = new TubeGeometry(path, 96, 0.085, 14, false)
  g.translate(0, 0, 0.19)
  return g
}

/** The tile colour from --r-mark, re-read when the appearance changes. */
function useMarkColor(): Color {
  const invalidate = useThree((s) => s.invalidate)
  const read = () =>
    new Color(getComputedStyle(document.documentElement).getPropertyValue('--r-mark').trim() || '#1a1b1f')
  const [color, setColor] = useState<Color>(read)
  useEffect(() => {
    const seen = new MutationObserver(() => {
      setColor(read())
      invalidate()
    })
    seen.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => seen.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invalidate])
  return color
}

export interface MarkSceneProps {
  /** Cello is working: turn slowly on a 1.6 second breath. */
  live?: boolean
  /** Motion is allowed. False draws the rest pose once. */
  motion?: boolean
  /** A still object for an empty or done state: rest pose, no pointer. */
  still?: StillName
}

export function MarkScene({ live = false, motion = true, still }: MarkSceneProps) {
  const group = useRef<Group>(null)
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)
  const tileColor = useMarkColor()
  const tile = useMemo(makeTile, [])
  const spiral = useMemo(makeSpiral, [])
  const target = useRef({ ...REST })
  // Seen moving once: the mark arrives turned away and settles into its pose.
  const arriving = useRef(motion && !live && !still)

  useEffect(() => {
    return () => {
      tile.dispose()
      spiral.dispose()
    }
  }, [tile, spiral])

  useEffect(() => {
    const g = group.current
    if (!g) return
    if (arriving.current) g.rotation.set(REST.x + 0.22, REST.y - 0.6, 0)
    else g.rotation.set(REST.x, REST.y, 0)
    invalidate()
  }, [invalidate])

  // The pointer turns the mark a few degrees while hovered, and it settles back.
  useEffect(() => {
    if (!motion || live || still) return
    const el = gl.domElement
    const move = (e: PointerEvent) => {
      const b = el.getBoundingClientRect()
      target.current = {
        x: REST.x - ((e.clientY - b.top) / b.height - 0.5) * 0.7,
        y: REST.y + ((e.clientX - b.left) / b.width - 0.5) * 0.9,
      }
      invalidate()
    }
    const leave = () => {
      target.current = { ...REST }
      invalidate()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
    }
  }, [gl, invalidate, motion, live, still])

  useFrame((state) => {
    const g = group.current
    if (!g || !motion) return
    if (live) {
      const p = state.clock.elapsedTime / 1.6
      g.rotation.y = REST.y + Math.sin(p * Math.PI) * 0.22
      g.rotation.x = REST.x + Math.cos(p * Math.PI * 0.5) * 0.06
      return
    }
    const ease = arriving.current ? 0.07 : 0.14
    g.rotation.x += (target.current.x - g.rotation.x) * ease
    g.rotation.y += (target.current.y - g.rotation.y) * ease
    const dx = Math.abs(target.current.x - g.rotation.x)
    const dy = Math.abs(target.current.y - g.rotation.y)
    if (dx > 0.002 || dy > 0.002) state.invalidate()
    else arriving.current = false
  })

  return (
    <>
      <group ref={group}>
        <mesh geometry={tile} receiveShadow>
          <meshStandardMaterial color={tileColor} roughness={0.3} metalness={0.2} />
        </mesh>
        <mesh geometry={spiral} castShadow>
          <meshStandardMaterial
            color="#3a8686"
            roughness={0.35}
            metalness={0.08}
            emissive="#0e3a3a"
            emissiveIntensity={0.25}
          />
        </mesh>
        {still === 'empty' && (
          <mesh position={[0, -1.18, -0.3]} receiveShadow>
            <boxGeometry args={[1.7, 0.12, 0.7]} />
            <meshStandardMaterial color={tileColor} roughness={0.5} metalness={0.1} />
          </mesh>
        )}
      </group>
      <ambientLight intensity={0.8} />
      <directionalLight
        position={[-1.6, 2.4, 2.2]}
        intensity={3}
        castShadow
        shadow-mapSize={[512, 512]}
        shadow-camera-left={-2}
        shadow-camera-right={2}
        shadow-camera-top={2}
        shadow-camera-bottom={-2}
        shadow-camera-near={0.1}
        shadow-camera-far={10}
        shadow-radius={3}
        shadow-bias={-0.002}
      />
      <directionalLight position={[1.6, 1.6, 0.4]} intensity={1.6} />
      <directionalLight position={[1.4, -1, 1.5]} intensity={0.6} color="#dfe8ff" />
    </>
  )
}
