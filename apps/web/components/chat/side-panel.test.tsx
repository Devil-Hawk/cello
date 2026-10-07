import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EDITABLE_FIELD, PanelView, typeWord, type PanelVersion, type PanelViewProps } from './side-panel'

const noop = () => undefined
const versions: PanelVersion[] = [
  { version: 2, author: 'user', content: { text: 'Dear team, v2' }, content_text: 'Dear team, v2', created_at: '2026-10-05T10:00:00Z' },
  { version: 1, author: 'cello', content: { text: 'Dear team, v1' }, content_text: 'Dear team, v1', created_at: '2026-10-05T09:00:00Z' },
]
const html = (over: Partial<PanelViewProps> = {}) =>
  renderToStaticMarkup(
    <PanelView thing={{ id: 'a1', type: 'cover_letter', title: 'Letter for Ramp' }} versions={versions} selected={2} onSelect={noop} editing={false} onEdit={noop} onSave={async () => ({ ok: true, markdown: '', versionLabel: '' })} onCancel={noop} onClose={noop} {...over} />
  )

describe('PanelView', () => {
  it('shows the kind, the title, every version and who wrote the one on show', () => {
    const out = html()
    expect(out).toContain('Cover letter')
    expect(out).toContain('Letter for Ramp')
    expect(out).toContain('Version 2 of 2')
    expect(out).toContain('Version 1 of 2')
    expect(out).toContain('You wrote this')
    expect(out).toContain('Dear team, v2')
    expect(html({ selected: 1 })).toContain('Cello wrote this')
  })

  it('offers Edit on the newest version of a kind with a text field, and not on an older one or another kind', () => {
    expect(html()).toContain('>Edit<')
    expect(html({ selected: 1 })).not.toContain('>Edit<')
    expect(html({ thing: { id: 'a2', type: 'research', title: 'Research' } })).not.toContain('>Edit<')
  })

  it('offers Attach, Keep and Use in a new chat only when the page gives them, and Download always', () => {
    expect(html()).not.toContain('>Attach<')
    expect(html()).not.toContain('>Keep<')
    expect(html()).toContain('>Download<')
    const out = html({ onAddToChat: noop, onUseInNewChat: noop, onKeep: noop })
    expect(out).toContain('>Attach<')
    expect(out).toContain('>Keep<')
    expect(out).toContain('>Use in a new chat<')
    expect(html({ onKeep: noop, kept: true })).toContain('>Kept<')
  })

  it('shows the person\'s draft in a field while editing, with Save as a new version', () => {
    const out = html({ editing: true })
    expect(out).toContain('Resume editor')
    expect(out).toContain('Save as a new version')
  })

  it('says so for something with no versions, and names an unknown kind in plain words', () => {
    expect(html({ versions: [], selected: 0 })).toContain('This has no versions yet.')
    expect(typeWord('comparison')).toBe('Comparison')
    expect(typeWord('some_new_kind')).toBe('some new kind')
    expect(Object.keys(EDITABLE_FIELD).sort()).toEqual(['cover_letter', 'message', 'resume'])
  })
})
