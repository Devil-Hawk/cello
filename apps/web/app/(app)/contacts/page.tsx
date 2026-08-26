'use client'

import { useEffect, useMemo, useState } from 'react'
import { Building2, ChevronDown, ChevronRight, FileWarning, Plus, Upload, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { EmptyStateHero } from '@/components/ui/empty-state-hero'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'
import { ContactDialog } from '@/components/contacts/contact-dialog'
import { ContactRow } from '@/components/contacts/contact-row'
import { ContactsEmptyPreview } from '@/components/contacts/empty-preview'
import { CsvImportDialog } from '@/components/contacts/csv-import'
import { PeopleGraph } from '@/components/contacts/people-graph'
import type {
  Contact,
  ContactCompany,
  ContactFormValues,
  CsvContactRow,
} from '@/components/contacts/types'

type ViewMode = 'graph' | 'list' | 'company'

function ContactsTableHead() {
  return (
    <thead>
      <tr className="border-b">
        <th scope="col" className="p-4 text-left text-label uppercase text-muted-foreground">Name</th>
        <th scope="col" className="p-4 text-left text-label uppercase text-muted-foreground">Company</th>
        <th scope="col" className="p-4 text-left text-label uppercase text-muted-foreground">Title</th>
        <th scope="col" className="p-4 text-left text-label uppercase text-muted-foreground">Relationship</th>
        <th scope="col" className="p-4 text-left text-label uppercase text-muted-foreground">Strength</th>
        <th scope="col" className="p-4 text-left text-label uppercase text-muted-foreground">Last contact</th>
        <th scope="col" className="p-4 text-right text-label uppercase text-muted-foreground">Actions</th>
      </tr>
    </thead>
  )
}

export default function ContactsPage() {
  const supabase = createClient()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [companies, setCompanies] = useState<ContactCompany[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [editingContact, setEditingContact] = useState<Contact | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('graph')
  const [expandedCompanies, setExpandedCompanies] = useState<Set<string>>(new Set())
  const [updatingContactId, setUpdatingContactId] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function fetchData() {
    setIsLoading(true)
    setLoadError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setLoadError("Couldn't verify your session. Sign in again and try again.")
        return
      }

      // Fetch contacts with company info
      const { data: contactsData, error: contactsError } = await supabase
        .from('contacts')
        .select('*, companies(id, name, logo_url)')
        .eq('user_id', user.id)
        .order('name')

      if (contactsError) {
        setLoadError("Couldn't load your contacts. Check your connection and try again.")
        return
      }
      setContacts((contactsData ?? []) as Contact[])

      // Fetch companies for dropdown
      const { data: companiesData, error: companiesError } = await supabase
        .from('companies')
        .select('id, name, logo_url')
        .eq('user_id', user.id)
        .order('name')

      if (companiesError) {
        setLoadError("Couldn't load your companies. Check your connection and try again.")
        return
      }
      setCompanies(companiesData ?? [])
    } catch {
      // A thrown failure (offline, DNS, aborted fetch) never produces a
      // Supabase `{ error }` object, so checking only that left this case
      // rendering "No contacts yet" on a hard load failure — and left the
      // effect with an unhandled rejection.
      setLoadError("Couldn't load your contacts. Check your connection and try again.")
    } finally {
      setIsLoading(false)
    }
  }

  function openAddModal() {
    setEditingContact(null)
    setShowAddModal(true)
  }

  function openEditModal(contact: Contact) {
    setEditingContact(contact)
    setShowAddModal(true)
  }

  function closeModal() {
    setShowAddModal(false)
    setEditingContact(null)
  }

  async function saveContact(form: ContactFormValues) {
    if (!form.name.trim()) return

    setIsSaving(true)
    // try/finally because a THROWN auth or network error used to leave
    // isSaving true forever — a permanently spinning Save button with no
    // message. The returned-{ error } paths below were already handled.
    try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      toast({
        title: 'Could not save contact',
        description: "Couldn't verify your session. Sign in again and try.",
        variant: 'destructive',
      })
      return
    }

    const contactData = {
      user_id: user.id,
      name: form.name.trim(),
      email: form.email.trim() || null,
      company_id: form.companyId,
      linkedin_url: form.linkedinUrl.trim() || null,
      title: form.title.trim() || null,
      relationship: form.relationship || null,
      notes: form.notes.trim() || null,
    }

    if (editingContact) {
      const { error } = await supabase
        .from('contacts')
        .update(contactData)
        .eq('id', editingContact.id)

      if (!error) {
        closeModal()
        fetchData()
      } else {
        toast({
          title: 'Could not save contact',
          description: `${form.name.trim()} was not updated. Try again.`,
          variant: 'destructive',
        })
      }
    } else {
      const { error } = await supabase.from('contacts').insert(contactData)

      if (!error) {
        closeModal()
        fetchData()
      } else {
        toast({
          title: 'Could not add contact',
          description: `${form.name.trim()} was not added. Try again.`,
          variant: 'destructive',
        })
      }
    }
    } catch {
      toast({
        title: 'Could not save contact',
        description: 'Check your connection and try again.',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function deleteContact(id: string) {
    if (!confirm('Are you sure you want to delete this contact?')) return

    const { error } = await supabase.from('contacts').delete().eq('id', id)
    if (!error) {
      setContacts(contacts.filter((c) => c.id !== id))
    } else {
      toast({
        title: 'Could not delete contact',
        description: 'The contact was not deleted. Try again.',
        variant: 'destructive',
      })
    }
  }

  async function markAsContactedToday(contactId: string) {
    setUpdatingContactId(contactId)
    const { error } = await supabase
      .from('contacts')
      .update({ last_contact_at: new Date().toISOString() })
      .eq('id', contactId)

    if (!error) {
      setContacts(
        contacts.map((c) =>
          c.id === contactId ? { ...c, last_contact_at: new Date().toISOString() } : c
        )
      )
    } else {
      toast({
        title: 'Could not update contact',
        description: "Marking as contacted today didn't save. Try again.",
        variant: 'destructive',
      })
    }
    setUpdatingContactId(null)
  }

  async function importFromCsv(rows: CsvContactRow[]) {
    if (rows.length === 0) return

    setIsImporting(true)
    // try/finally for the same reason as saveContact: a thrown error left the
    // Import button spinning forever with nothing said.
    try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      toast({
        title: 'Could not import contacts',
        description: "Couldn't verify your session. Sign in again and try.",
        variant: 'destructive',
      })
      return
    }

    const contactsToInsert = rows.map((row) => ({
      user_id: user.id,
      name: row.name,
      email: row.email,
      title: row.title,
      linkedin_url: row.linkedin_url,
    }))

    const { error } = await supabase.from('contacts').insert(contactsToInsert)
    if (!error) {
      setShowImportModal(false)
      fetchData()
    } else {
      toast({
        title: 'Import failed',
        description: `${rows.length} contact${rows.length === 1 ? '' : 's'} could not be imported. Try again.`,
        variant: 'destructive',
      })
    }
    } catch {
      toast({
        title: 'Import failed',
        description: 'Check your connection and try again.',
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
    }
  }

  function setView(mode: ViewMode) {
    setViewMode(mode)
    if (mode === 'company') {
      // Expand all by default
      const allCompanyIds = new Set(
        contacts.filter((c) => c.company_id).map((c) => c.company_id!)
      )
      allCompanyIds.add('no-company')
      setExpandedCompanies(allCompanyIds)
    }
  }

  // Group contacts by company
  const groupedContacts = useMemo(() => {
    if (viewMode !== 'company') return null

    const groups = new Map<string, { company: ContactCompany; contacts: Contact[] }>()
    const noCompany: Contact[] = []

    contacts.forEach((contact) => {
      if (contact.company_id && contact.companies) {
        const existing = groups.get(contact.company_id)
        if (existing) {
          existing.contacts.push(contact)
        } else {
          groups.set(contact.company_id, {
            company: contact.companies,
            contacts: [contact],
          })
        }
      } else {
        noCompany.push(contact)
      }
    })

    return { groups: Array.from(groups.values()), noCompany }
  }, [contacts, viewMode])

  function toggleCompanyExpansion(companyId: string) {
    const newExpanded = new Set(expandedCompanies)
    if (newExpanded.has(companyId)) {
      newExpanded.delete(companyId)
    } else {
      newExpanded.add(companyId)
    }
    setExpandedCompanies(newExpanded)
  }

  function renderContactRow(contact: Contact) {
    return (
      <ContactRow
        key={contact.id}
        contact={contact}
        isUpdating={updatingContactId === contact.id}
        onMarkContacted={markAsContactedToday}
        onEdit={openEditModal}
        onDelete={deleteContact}
      />
    )
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="font-display text-title text-foreground">Contacts</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Your network, and the referral paths inside it.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => setShowImportModal(true)}>
          <Upload className="h-4 w-4" />
          Import CSV
        </Button>
        <Button onClick={openAddModal}>
          <Plus className="h-4 w-4" />
          Add contact
        </Button>
      </div>
    </div>
  )

  if (isLoading) {
    return (
      <div className="space-y-6">
        {header}
        <Card className="overflow-hidden">
          <div className="space-y-0 divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-4">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={FileWarning}
          title="Couldn't load your contacts"
          body={loadError}
          action={<Button onClick={fetchData}>Retry</Button>}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {header}

      {contacts.length > 0 && (
        <div className="flex items-center justify-between">
          <Segmented<ViewMode>
            aria-label="Group contacts"
            options={[
              { value: 'graph', label: 'Network' },
              { value: 'list', label: 'All contacts' },
              { value: 'company', label: 'By company' },
            ]}
            value={viewMode}
            onValueChange={setView}
          />
          <span className="text-caption tabular-nums text-muted-foreground">
            {contacts.length} contact{contacts.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {contacts.length === 0 ? (
        <EmptyStateHero
          icon={Users}
          eyebrow="Network · empty"
          title="Warm intros beat cold applications"
          body="Add the people who can open a door — colleagues, alumni, recruiters. Cello tracks how strong each connection is and nudges you when it's time to reach out."
          action={
            <>
              <Button onClick={openAddModal}>
                <Plus className="h-4 w-4" />
                Add contact
              </Button>
              <Button variant="outline" onClick={() => setShowImportModal(true)}>
                <Upload className="h-4 w-4" />
                Import from CSV
              </Button>
            </>
          }
          preview={<ContactsEmptyPreview />}
          className="min-h-[26rem]"
        />
      ) : viewMode === 'graph' ? (
        <PeopleGraph contacts={contacts} onSelectContact={openEditModal} />
      ) : viewMode === 'company' && groupedContacts ? (
        <div className="space-y-4">
          {groupedContacts.groups.map(({ company, contacts: groupContacts }) => (
            <Card key={company.id} className="overflow-hidden">
              <button
                type="button"
                className="flex w-full items-center gap-3 p-4 transition-colors hover:bg-sunken/60"
                onClick={() => toggleCompanyExpansion(company.id)}
                aria-expanded={expandedCompanies.has(company.id)}
                aria-controls={`contacts-group-${company.id}`}
              >
                {expandedCompanies.has(company.id) ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                )}
                {company.logo_url ? (
                  <img
                    src={company.logo_url}
                    alt=""
                    className="h-6 w-6 rounded bg-white object-contain"
                  />
                ) : (
                  <Building2 className="h-6 w-6 text-muted-foreground" aria-hidden />
                )}
                <span className="text-body font-medium text-foreground">{company.name}</span>
                <span className="text-caption tabular-nums text-muted-foreground">
                  {groupContacts.length} contact{groupContacts.length !== 1 ? 's' : ''}
                </span>
              </button>
              {expandedCompanies.has(company.id) && (
                <div id={`contacts-group-${company.id}`} className="overflow-x-auto border-t">
                  <table className="w-full">
                    <ContactsTableHead />
                    <tbody>{groupContacts.map(renderContactRow)}</tbody>
                  </table>
                </div>
              )}
            </Card>
          ))}
          {groupedContacts.noCompany.length > 0 && (
            <Card className="overflow-hidden">
              <button
                type="button"
                className="flex w-full items-center gap-3 p-4 transition-colors hover:bg-sunken/60"
                onClick={() => toggleCompanyExpansion('no-company')}
                aria-expanded={expandedCompanies.has('no-company')}
                aria-controls="contacts-group-no-company"
              >
                {expandedCompanies.has('no-company') ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                )}
                <Users className="h-6 w-6 text-muted-foreground" aria-hidden />
                <span className="text-body font-medium text-foreground">No company</span>
                <span className="text-caption tabular-nums text-muted-foreground">
                  {groupedContacts.noCompany.length} contact
                  {groupedContacts.noCompany.length !== 1 ? 's' : ''}
                </span>
              </button>
              {expandedCompanies.has('no-company') && (
                <div id="contacts-group-no-company" className="overflow-x-auto border-t">
                  <table className="w-full">
                    <ContactsTableHead />
                    <tbody>{groupedContacts.noCompany.map(renderContactRow)}</tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <ContactsTableHead />
              <tbody>{contacts.map(renderContactRow)}</tbody>
            </table>
          </div>
        </Card>
      )}

      <ContactDialog
        open={showAddModal}
        onOpenChange={(open) => {
          if (!open) closeModal()
          else setShowAddModal(true)
        }}
        contact={editingContact}
        companies={companies}
        isSaving={isSaving}
        onSubmit={saveContact}
      />

      <CsvImportDialog
        open={showImportModal}
        onOpenChange={setShowImportModal}
        isImporting={isImporting}
        onImport={importFromCsv}
      />
    </div>
  )
}
