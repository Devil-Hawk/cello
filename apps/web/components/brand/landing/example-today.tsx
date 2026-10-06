import { Bead } from '@/components/ui/bead'
import { Tile } from '@/components/ui/tile'

// A frame of Today with made-up companies, labelled as an example. Static:
// nothing in it is a control, so nothing here takes focus.
export function ExampleToday() {
  return (
    <figure className="m-0">
      <figcaption className="r-meta mb-3">Example. These companies are made up.</figcaption>
      <div className="r-sheet-lead" role="group" aria-label="Example of Today">
        <p className="r-title">2 things need you.</p>
        <div className="mt-5 flex items-start gap-3">
          <Tile size={56} kind="initial" ring>
            V
          </Tile>
          <div className="min-w-0">
            <p className="r-name">Applied AI Engineer</p>
            <p className="r-name">Vantage Loom</p>
            <p className="mt-1 inline-flex items-center gap-2 text-sm text-r-copper-text">
              <Bead /> Replied today
            </p>
          </div>
        </div>
        <span className="r-key r-key-ink mt-5 w-fit" aria-hidden>
          Reply
        </span>
      </div>
      <div className="r-sheet mt-4 flex items-start gap-3">
        <Tile size={48} kind="initial">
          O
        </Tile>
        <div className="min-w-0">
          <p className="r-name">Data Engineer</p>
          <p className="r-name">Orchid Ledger</p>
        </div>
      </div>
    </figure>
  )
}
