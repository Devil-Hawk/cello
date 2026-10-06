import { redirect } from 'next/navigation'
import { recordHref } from '@/lib/routes/roles'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// /jobs is Roles now. An old link to one role (?job=<id>) opens that role's record;
// every other old address, with its filters, opens Roles.
export default function JobsRedirect({ searchParams }: { searchParams: { job?: string | string[] } }) {
  const job = Array.isArray(searchParams.job) ? searchParams.job[0] : searchParams.job
  redirect(job && UUID.test(job) ? recordHref(job) : '/roles')
}
