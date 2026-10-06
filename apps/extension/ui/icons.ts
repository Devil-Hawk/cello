// Three icons, copied from lucide (ISC license): play, pause and check. Static markup
// only, drawn with the text colour, hidden from screen readers (the button's own words
// are the label).

const PATHS = {
  // lucide "play"
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  // lucide "pause"
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  // lucide "check"
  check: '<path d="M20 6 9 17l-5-5"/>',
} as const

export type IconName = keyof typeof PATHS

export function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = PATHS[name]
  return svg
}
