'use client'

// "Choose any template" — the picker over lib/resume/templates.ts.
//
// IT READS THE REGISTRY, ALWAYS
//   The options come from RESUME_TEMPLATES at render time. Nothing here names a
//   template, so adding one to the registry makes it appear with a correct
//   thumbnail and nothing to update. A hardcoded list would mean a new template
//   silently never ships.
//
// IT IS A REAL RADIO GROUP
//   A fieldset/legend with native <input type="radio">, not clickable divs. That
//   buys the behaviour a keyboard user expects for free and cannot be faked
//   convincingly: one tab stop for the whole group, arrow keys to move between
//   options, the group's name announced with the selected option. The inputs are
//   `sr-only` (clipped, NOT `display:none`) so they keep focus and hit-testing;
//   the visible card is styled through `peer-focus-visible:` so the focus ring
//   lands on what a sighted user sees.
//
// THE THUMBNAILS ARE DRAWN FROM THE SPEC, NOT FROM A PDF
//   Each miniature is plain divs sized from the same TemplateSpec the exporter
//   uses: page margins become padding, type sizes become bar heights, rules are
//   drawn where the spec puts rules, and bullet/leading spacing sets the density.
//   So Compact reads as dense and Minimal as airy for the same reason the
//   exported documents do. They are aria-hidden — the name and description under
//   each card carry the meaning, and a screen reader gets those instead of a
//   pile of decorative boxes.

import { RESUME_TEMPLATES, type TemplateSpec } from '@/lib/resume/templates'
import { cn } from '@/lib/utils'
import { PREVIEW_FONT_STACKS } from './template-preview-style'

/**
 * Thumbnail width in CSS px; the height follows US Letter's 8.5:11 ratio.
 * Sized so four templates sit in one row without pushing the document itself
 * below the fold — a picker the user has to scroll to find is a picker they
 * never use.
 */
const THUMB_WIDTH = 132
const PAGE_WIDTH_PT = 612
const PAGE_HEIGHT_PT = 792
const THUMB_SCALE = THUMB_WIDTH / PAGE_WIDTH_PT
const THUMB_HEIGHT = Math.round(PAGE_HEIGHT_PT * THUMB_SCALE)

/** Points -> thumbnail px, with a floor so a hairline rule never rounds away. */
function px(points: number, min = 0): number {
  return Math.max(min, Math.round(points * THUMB_SCALE * 100) / 100)
}

function Bar({
  width,
  height,
  color,
  opacity = 1,
  marginTop = 0,
  align = 'left',
}: {
  width: string
  height: number
  color: string
  opacity?: number
  marginTop?: number
  align?: 'left' | 'center'
}) {
  return (
    <div
      style={{
        width,
        height: Math.max(height, 1.5),
        backgroundColor: color,
        opacity,
        marginTop,
        marginLeft: align === 'center' ? 'auto' : undefined,
        marginRight: align === 'center' ? 'auto' : undefined,
        borderRadius: 0.5,
      }}
    />
  )
}

function Rule({ thickness, color, gap, widthFactor }: { thickness: number; color: string; gap: number; widthFactor: number }) {
  return (
    <div
      style={{
        height: Math.max(px(thickness), 0.75),
        width: `${Math.min(widthFactor, 1) * 100}%`,
        backgroundColor: color,
        marginTop: px(gap),
      }}
    />
  )
}

/** One section: its heading treatment, its rule (if any) and two bullet rows. */
function Section({ spec, lines }: { spec: TemplateSpec; lines: number }) {
  const h2 = spec.headings[2]
  const { colors, bullets, body } = spec
  return (
    <div style={{ marginTop: px(h2.spaceBefore) }}>
      <Bar
        width="34%"
        height={px(h2.size) * 0.72}
        color={h2.accent ? colors.accent : colors.text}
        opacity={h2.accent ? 1 : 0.85}
      />
      {h2.rule && (
        <Rule
          thickness={h2.rule.thickness}
          color={h2.rule.accent ? colors.accent : colors.text}
          gap={h2.rule.gap}
          widthFactor={h2.rule.widthFactor}
        />
      )}
      <div style={{ marginTop: px(h2.spaceAfter) }}>
        {Array.from({ length: lines }).map((_, index) => (
          <div
            key={index}
            style={{
              display: 'flex',
              gap: px(bullets.hangingIndent, 1.5),
              marginLeft: px(bullets.indent),
              marginTop: index === 0 ? 0 : px(bullets.itemSpacing, 1),
            }}
          >
            <div
              style={{
                width: 1.5,
                height: px(body.size) * 0.55,
                backgroundColor: colors.text,
                opacity: 0.55,
                marginTop: px(body.size) * 0.2,
              }}
            />
            <div
              style={{
                flex: 1,
                height: px(body.size) * 0.55,
                backgroundColor: colors.text,
                opacity: 0.45,
                // Leading is what makes Compact feel dense and Minimal airy.
                marginBottom: px(body.size * (body.lineHeight - 1)),
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/** A miniature page drawn entirely from the template's own measurements. */
export function TemplateThumbnail({ spec }: { spec: TemplateSpec }) {
  const { nameBlock, colors, page } = spec
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-[3px] border border-border/70 bg-white"
      style={{
        width: '100%',
        maxWidth: THUMB_WIDTH,
        height: THUMB_HEIGHT,
        margin: '0 auto',
        paddingTop: px(page.margins.top),
        paddingRight: px(page.margins.right),
        paddingBottom: px(page.margins.bottom),
        paddingLeft: px(page.margins.left),
        fontFamily: PREVIEW_FONT_STACKS[spec.fonts.body],
      }}
    >
      <Bar
        width={nameBlock.nameAlign === 'center' ? '58%' : '52%'}
        height={px(nameBlock.nameSize) * 0.7}
        color={nameBlock.nameAccent ? colors.accent : colors.text}
        opacity={nameBlock.nameBold ? 1 : 0.8}
        align={nameBlock.nameAlign}
      />
      <Bar
        width={nameBlock.contactAlign === 'center' ? '70%' : '64%'}
        height={px(nameBlock.contactSize) * 0.6}
        color={nameBlock.contactMuted ? colors.muted : colors.text}
        opacity={0.6}
        marginTop={px(3, 1)}
        align={nameBlock.contactAlign}
      />
      {nameBlock.rule && (
        <Rule
          thickness={nameBlock.rule.thickness}
          color={nameBlock.rule.accent ? colors.accent : colors.text}
          gap={nameBlock.rule.gap}
          widthFactor={nameBlock.rule.widthFactor}
        />
      )}
      <div style={{ marginTop: px(nameBlock.spaceAfter) }}>
        <Section spec={spec} lines={3} />
        <Section spec={spec} lines={2} />
      </div>
    </div>
  )
}

export interface TemplatePickerProps {
  /** Currently selected template id. Unknown ids simply match nothing. */
  value: string
  onChange: (templateId: string) => void
  /** Radio group name — unique per instance if a page ever shows two pickers. */
  name?: string
  className?: string
  disabled?: boolean
}

export function TemplatePicker({
  value,
  onChange,
  name = 'resume-template',
  className,
  disabled,
}: TemplatePickerProps) {
  return (
    <fieldset className={cn('m-0 min-w-0 border-0 p-0', className)} disabled={disabled}>
      <legend className="mb-2 text-label uppercase text-muted-foreground">Template</legend>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {RESUME_TEMPLATES.map((spec) => {
          const isSelected = spec.id === value
          return (
            <label key={spec.id} className="group relative block cursor-pointer">
              <input
                type="radio"
                name={name}
                value={spec.id}
                checked={isSelected}
                onChange={() => onChange(spec.id)}
                className="peer sr-only"
              />
              <span
                className={cn(
                  'flex h-full flex-col gap-2 rounded-card border-2 bg-card p-2 transition-colors',
                  'peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background',
                  isSelected ? 'border-accent' : 'border-border hover:border-muted-foreground/40'
                )}
              >
                <TemplateThumbnail spec={spec} />
                <span className="block">
                  <span
                    className={cn(
                      'block text-caption font-medium',
                      isSelected ? 'text-accent-deep' : 'text-foreground'
                    )}
                  >
                    {spec.name}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                    {spec.description}
                  </span>
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
