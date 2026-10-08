import { redirect } from 'next/navigation'

// Applications moved to /applications.
export default function PipelinePage() {
  redirect('/applications')
}
