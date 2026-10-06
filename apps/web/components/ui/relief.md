# Relief: the visual contract

Written from the accepted mocks (design/v5/i-material, design/v6-relief-deep) before any page is built on it. Every page package builds from this file. A change to it goes back to the owner.

## The idea

A warm neutral ground with surfaces resting on it under true shadows. Elevation is priority: what needs the person sits highest, what Cello holds for them sits one level down, Cello's own work sits flush on the ground, and finished things lie flat. Logos lead every surface as app icon tiles in their real colour, so the eye lands on the company before any word.

## Type

Figtree, weights 400, 500 and 600, tabular numerals everywhere. Three steps above body. Sentence case. Letter spacing tightens with size (-0.01em to -0.03em).

| Step | Size | Use |
|---|---|---|
| Display | 48 (36 phone), 56 on Welcome | Page heading, at most six words |
| Section | 28 (26 phone) | The lead quote (32 on Today), the opened record's title |
| Title | 18 | Group headings, card quotes |
| Body | 15 | Everything else |
| Meta | 13 | Dates, sources, group labels |

Chance words carry weight by colour: Strong in ink 600, Possible in ink 2, Stretch in ink 3.

## Colour

| Role | Light | Dark | Rule |
|---|---|---|---|
| Ground | #ECEBE7 | #17181C | The page. Warm neutral in both, never white, never black. |
| Surface | #FAFAF8 | #202126 | Level 1 sheets. |
| Raised | #FEFEFD | #292A30 | Level 2 sheets, keys, the current page key. |
| Ink | #1A1B1F | #ECEBE7 | Text, primary keys, done things, Strong. |
| Ink 2 | #5A5D65 | #B4B7BF | Secondary text, every state word, Cello's read. |
| Ink 3 | #8B8E96 | #94979F | Meta, group labels, Stretch. |
| Copper | #C2641A | #E0905A | Needs you, and nothing else: the bead, the word inside a Needs you group, the nav numeral, the ring on the lead tile. Never a fill or a button. |
| Petrol | #3A8686 | #5FB3B3 | Cello's own mark and the spiral beside work Cello did. Never on every row. |
| Confirmed | #2F7A4D | #5CB57E | The double check glyph only. |
| Blocked | #B4402D | #E07A66 | The lock glyph only. Red appears nowhere else. |

The line is the ink at 8 percent (9 percent of light in dark) and is the only border in the system. Every text token passes 4.5 to 1 on ground, surface and raised, in both appearances. Ink keys carry white text in light and the ground colour in dark.

## Space and radii

Scale 4, 8, 12, 16, 24, 32, 40, 56, 80. Sheet padding 24 (28 on a lead sheet or a record). Rows 12 vertical. Groups 40 apart on a laptop, 56 on a phone. Page gutter 24 (16 phone). Content column 1200. Radii: sheets 20 (18 phone), keys 12, tiles 23.5 percent of their size, pills 999. Every target is at least 44px.

## Light and depth

One key light, upper left, about 10 o'clock and 60 degrees up. Shadows fall straight down. Five elevations, and no other shadow exists:

| Level | Name | Used for |
|---|---|---|
| 0 | Flat | Closed companies, done things, lists on the ground |
| contact | Touching | A key at rest, a bead, a tile in a ground list |
| 1 | Held | Level 1 sheets, a row on hover, the bar's own body |
| 2 | Lifted | The one lead sheet, the opened record |
| ring | Needs you | The copper ring, only on the logo tile of the lead surface |

Every lit object has a 1px lit top edge (white at .85 on light surfaces, .07 on dark). Gradients exist only as light falloff on a surface or object (a tile's sheen, a bead's highlight) and as the fade where folded text ends. Glass (backdrop blur) is only on the sticky bar and a phone sheet, and is dropped where reduced transparency is asked.

Only transform, opacity and shadow animate.

## The dimensional layer

CSS 3D carries most of it: the bar is a raised plinth with the current page a key 1px proud; keys sit down when pressed; tiles are app icons with bevel, sheen and a contact shadow and lift 1px toward the pointer; beads are small lit objects marking live states only; the fit strip stands up for a strength and lies flat for a gap; an opened group rises 250 ms with translateZ.

WebGL is allowed only for the Cello mark in the bar and on its own the working mark beside "Cello is working". Two canvases a page at most, each 96 CSS px or smaller, rendered on demand, stopped when the tab is hidden. Each has an SVG twin of the same silhouette in the same box. Reduced motion draws one still frame. Without WebGL, with Save-Data, or on a device with 2 GB of memory or less, the twin renders and nothing shifts.

Still objects for empty and done states (the quiet Today, an empty For you) are pre-rendered images in webp at 1x and 2x, never canvases.

## Logo tiles

Square, radius 23.5 percent. Sizes 28 (chip), 36, 40 to 44 (lists), 48 (cards), 56 (Roles list), 64 (lead, record, wall), 80 (company header). A square mark fills the tile and the tile carries the brand colour. A glyph mark sits on white at about 60 percent of the tile. A missing logo is the same tile with the initial in ink 2. Tiles stack edge to edge with a 4px gap, three at most and a plus N tile. Closed companies lie flat and desaturated 55 percent. The bevel dose follows the size: lg from 48, xl from 56 adds the ambient layer.

## Role titles

Wherever a role appears with its employer, the title is set at the company name's size, weight and colour, on the same line or directly under it. It is never truncated before the company name: each keeps at least 40 percent of the line at 390px, and a 60 character title wraps. The title opens the record in one click. This is built once in the shared tile and row components and nowhere else.

## Motion

Hover tints at 150 ms, a 4px rise on reveal at 250 ms, the working spiral breathing at 1.6 s. Nothing moves on load. Reduced motion stops all of it.

## Copy caps

First screens hold 90 words and 5 groups on a laptop, 45 words and 3 groups on a phone. The copy scan fails a first view sentence over the cap. A line marked on request lives in a Learn more, a tooltip or the FAQ.

## The innovative way of seeing the search

The fit strip. One pill per requirement across the width of the record, read as an instrument: a met pill stands up as a key, a partly met one carries the lit edge, a missing one lies flat in the line. The strip is on the record (4.6). It reads as "5 pluses, 1 minus, 3 not sure" and every pill opens its evidence. No other job tool shows a role as an instrument of what you bring against what it asks.

## The still objects

Two: Today's quiet state and Roles' empty For you. Rendered once from Cello's scenes by `pnpm depth:stills` and committed under public/depth.

## The fixed list

- lucide-react 1.x only, one stroke width (1.75)
- No emoji, sparkle, stamps, highlighter marks, poster headlines, flat saturated fields, thick outlines or cards in cards
- No gradient, glass or glow except as the dimensional layer allows
- Nothing that shows what was sent as a word, motif or feature on show
- Refined and premium, not cartoony; generous space and little on screen at once
- One light, one elevation scale, one tokens file (app/relief.css)
