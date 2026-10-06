import { browser } from 'wxt/browser'
import { fitScreenshot } from '../lib/shrink'

// One JPEG of the tab the person just sent from, at quality 60, under 250 KB or not at all.

export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

const toDataUrl = (buf: ArrayBuffer, mime: string): string => `data:${mime};base64,${toBase64(new Uint8Array(buf))}`

async function reencode(dataUrl: string, scale: number, quality: number): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob()
  const bmp = await createImageBitmap(blob)
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')?.drawImage(bmp, 0, 0, w, h)
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return toDataUrl(await out.arrayBuffer(), 'image/jpeg')
}

export async function captureConfirmation(windowId: number | undefined): Promise<string | null> {
  try {
    const shot = await browser.tabs.captureVisibleTab(windowId ?? browser.windows.WINDOW_ID_CURRENT, {
      format: 'jpeg',
      quality: 60,
    })
    return await fitScreenshot(shot, (scale, quality) => reencode(shot, scale, quality))
  } catch {
    return null
  }
}
