import { redirect } from 'next/navigation'

// Results moved to Applications.
export default function InsightsPage() {
  redirect('/applications?view=results')
}
