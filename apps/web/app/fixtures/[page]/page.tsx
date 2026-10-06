import { Bead } from '@/components/ui/bead'
import { Disclosure } from '@/components/ui/disclosure'
import { Key } from '@/components/ui/key'
import { Plinth } from '@/components/ui/plinth'
import { Tile } from '@/components/ui/tile'
import { Mark } from '@/components/depth/mark'
import { fixtureRows } from '../_data'

// Any page that has no fixture of its own yet: the primitives on the ground,
// 25 rows, one bar mark. Each page package adds a static fixtures/<page>/page.tsx,
// which wins over this one. Nothing here reads Supabase.
export default function FixturePage({ params }: { params: { page: string } }) {
  const rows = fixtureRows(25)
  return (
    <main id="main-content" className="mx-auto max-w-[1200px] px-4 pb-24 pt-3 sm:px-6">
      <Plinth as="header" className="flex h-14 items-center gap-4 px-3">
        <Mark size={36} />
        <span className="r-title">Fixture</span>
        <Key variant="raised" current className="ml-1">
          {params.page}
        </Key>
        <span className="flex-1" />
        <Key variant="ghost">Find</Key>
      </Plinth>

      <h1 className="r-display mt-10">{params.page}</h1>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Key>Interested</Key>
        <Key variant="raised">Not for me</Key>
        <Key variant="ghost">Later</Key>
        <span className="inline-flex items-center gap-2 text-r-copper-text">
          <Bead /> Needs you
        </span>
      </div>

      <section className="mt-10 r-sheet">
        {rows.map((r) => (
          <div key={r.id} className="r-row flex items-start gap-3 px-2 py-3">
            <Tile size={48} kind="initial">
              {r.company.name[0]}
            </Tile>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-x-2">
                <span className="r-name">{r.title}</span>
                <span className="r-name">{r.company.name}</span>
              </div>
              <p className="r-meta">
                {r.place} · {r.posted}
              </p>
            </div>
          </div>
        ))}
      </section>

      <section className="mt-10 r-sheet-lead">
        <Disclosure title="Requirements" count={9}>
          <p className="r-body text-r-ink-2">Made-up content for a fixture.</p>
        </Disclosure>
        <Disclosure title="The posting" count="6 sections">
          <p className="r-body text-r-ink-2">Made-up content for a fixture.</p>
        </Disclosure>
      </section>
    </main>
  )
}
