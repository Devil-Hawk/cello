import { LoginForm, type LoginNotice } from '@/components/auth/login-form'

export const metadata = {
  title: 'Sign in',
}

// The query reaches the page as props, so the form needs no search-params hook
// and Landing's "Have a demo code?" can open the code field directly.
//   ?error=...      the Google round trip came back without a session
//   ?demo=expired   middleware ended a demo whose window closed
//   ?demo=code      open the demo code field
export default function LoginPage({ searchParams }: { searchParams: { error?: string; demo?: string } }) {
  const notice: LoginNotice =
    searchParams.demo === 'expired' ? 'demo-expired' : searchParams.error ? 'cancelled' : null
  return <LoginForm notice={notice} openDemo={searchParams.demo === 'code'} />
}
