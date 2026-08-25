/**
 * A non-interactive sketch of the contacts table, shown behind the contacts
 * empty state so the surface previews the network it will hold.
 */
export function ContactsEmptyPreview() {
  const rows = [
    { w: 'w-32', strength: 'w-4/5', bar: 'bg-pipeline-offer' },
    { w: 'w-40', strength: 'w-1/2', bar: 'bg-pipeline-screen' },
    { w: 'w-28', strength: 'w-2/3', bar: 'bg-pipeline-offer' },
    { w: 'w-36', strength: 'w-1/3', bar: 'bg-pipeline-ghosted' },
    { w: 'w-32', strength: 'w-3/5', bar: 'bg-pipeline-screen' },
  ]

  return (
    <div className="overflow-hidden rounded-card border bg-card">
      <div className="grid grid-cols-[1.6fr_1fr_1fr] gap-4 border-b px-4 py-3">
        {['Name', 'Company', 'Strength'].map((h) => (
          <span
            key={h}
            className="font-readout text-label uppercase tracking-[0.1em] text-muted-foreground"
          >
            {h}
          </span>
        ))}
      </div>
      {rows.map((row, i) => (
        <div
          key={i}
          className="grid grid-cols-[1.6fr_1fr_1fr] items-center gap-4 border-b px-4 py-3.5 last:border-0"
        >
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 shrink-0 rounded-full bg-sunken" />
            <div className="space-y-1.5">
              <div className={`h-2.5 rounded-full bg-sunken ${row.w}`} />
              <div className="h-2 w-24 rounded-full bg-sunken" />
            </div>
          </div>
          <div className="h-2.5 w-20 rounded-full bg-sunken" />
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-sunken">
              <div className={`h-full rounded-full ${row.bar} ${row.strength}`} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
