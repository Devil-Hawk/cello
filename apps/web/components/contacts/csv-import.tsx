'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { parseContactsCsv } from '@/lib/contacts/parse-csv'
import type { CsvContactRow } from './types'

export interface CsvImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isImporting: boolean
  /** Called with every valid row in the CSV (not just the preview). */
  onImport: (rows: CsvContactRow[]) => void
}

/** Bulk CSV import dialog: file upload or paste, live preview of the first 5 rows. */
export function CsvImportDialog({
  open,
  onOpenChange,
  isImporting,
  onImport,
}: CsvImportDialogProps) {
  const [csvData, setCsvData] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const parsed = useMemo(() => parseContactsCsv(csvData), [csvData])

  useEffect(() => {
    if (!open) setCsvData('')
  }, [open])

  function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (e) => {
      setCsvData((e.target?.result as string) || '')
    }
    reader.readAsText(file)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import contacts from CSV</DialogTitle>
          <DialogDescription>
            Columns: name (required), email, company, title, linkedin_url
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <input
              type="file"
              accept=".csv"
              ref={fileInputRef}
              onChange={handleFileUpload}
              className="hidden"
            />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4" />
              Choose file
            </Button>
          </div>

          <div>
            <label htmlFor="csv-paste" className="text-body font-medium text-foreground">
              Or paste CSV content
            </label>
            <textarea
              id="csv-paste"
              value={csvData}
              onChange={(e) => setCsvData(e.target.value)}
              placeholder={'name,email,company,title,linkedin_url\nJohn Doe,john@example.com,Acme Inc,Engineer,https://linkedin.com/in/johndoe'}
              rows={6}
              className="mt-1.5 flex w-full resize-none rounded-control border border-input bg-card px-3 py-2 font-mono text-caption text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            />
            {parsed.missingNameColumn && (
              <p className="mt-1 text-caption text-destructive">
                CSV must have a &quot;name&quot; column
              </p>
            )}
            {/* A header row with no data used to produce silence — no preview,
                no error, no explanation — because it returned the same shape as
                a file with no name column. */}
            {parsed.headerOnly && (
              <p className="mt-1 text-caption text-muted-foreground">
                That&apos;s just the header row — add at least one contact below it.
              </p>
            )}
          </div>

          {parsed.preview.length > 0 && (
            <div>
              <p className="text-body font-medium text-foreground">
                Preview{' '}
                <span className="font-normal text-muted-foreground">
                  — {parsed.rows.length} contact{parsed.rows.length !== 1 ? 's' : ''} found
                </span>
              </p>
              <div className="mt-1.5 overflow-x-auto rounded-card border">
                <table className="w-full text-caption">
                  <thead>
                    <tr className="border-b bg-sunken/60">
                      <th scope="col" className="p-2 text-left font-medium text-muted-foreground">Name</th>
                      <th scope="col" className="p-2 text-left font-medium text-muted-foreground">Email</th>
                      <th scope="col" className="p-2 text-left font-medium text-muted-foreground">Company</th>
                      <th scope="col" className="p-2 text-left font-medium text-muted-foreground">Title</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.preview.map((row, idx) => (
                      <tr key={idx} className="border-b last:border-0">
                        <td className="p-2">{row.name || '—'}</td>
                        <td className="p-2">{row.email || '—'}</td>
                        <td className="p-2">{row.company || '—'}</td>
                        <td className="p-2">{row.title || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Say so when we refused an address. The contact is still imported —
              losing a real person over one bad cell would be worse — but an
              unusable address must never pass silently, because everything
              downstream treats a non-null email as a send target. */}
          {parsed.rejected.length > 0 && (
            <div className="rounded-card border border-pipeline-screen/40 bg-sunken/60 p-3">
              <p className="text-caption font-medium text-foreground">
                {parsed.rejected.length === 1
                  ? '1 address was not usable and has been left blank'
                  : `${parsed.rejected.length} addresses were not usable and have been left blank`}
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {parsed.rejected.slice(0, 5).map((r) => (
                  <li key={`${r.line}-${r.value}`} className="text-caption text-muted-foreground">
                    Line {r.line}, {r.name}: <span className="font-mono">{r.value}</span>
                  </li>
                ))}
              </ul>
              {parsed.rejected.length > 5 && (
                <p className="mt-1 text-caption text-muted-foreground">
                  …and {parsed.rejected.length - 5} more.
                </p>
              )}
              <p className="mt-1.5 text-caption text-muted-foreground">
                These contacts import without an email. Check for a stray comma in a quoted field.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => onImport(parsed.rows)}
            disabled={parsed.rows.length === 0 || isImporting}
          >
            {isImporting && <Loader2 className="h-4 w-4 animate-spin" />}
            Import {parsed.rows.length > 0 ? `${parsed.rows.length} contacts` : 'contacts'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
