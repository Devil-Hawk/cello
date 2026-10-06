// A confirmation screenshot is sent only when it is under 250 KB. A bigger one is
// re-encoded smaller; if it still does not fit it is not sent.

export const MAX_SCREENSHOT_BYTES = 250 * 1024

export function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.split(',')[1] ?? ''
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

const STEPS: Array<[scale: number, quality: number]> = [
  [1, 0.45],
  [0.75, 0.4],
  [0.5, 0.35],
  [0.35, 0.3],
]

export async function fitScreenshot(
  dataUrl: string,
  encode: (scale: number, quality: number) => Promise<string>,
  max = MAX_SCREENSHOT_BYTES,
): Promise<string | null> {
  if (dataUrlBytes(dataUrl) <= max) return dataUrl
  for (const [scale, quality] of STEPS) {
    const smaller = await encode(scale, quality)
    if (dataUrlBytes(smaller) <= max) return smaller
  }
  return null
}
