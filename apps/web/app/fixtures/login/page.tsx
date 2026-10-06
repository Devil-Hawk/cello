import { LoginForm, type LoginNotice } from '@/components/auth/login-form'

// ?state=cancelled | demo-expired | code  (the demo code field opens)
export default function LoginFixture({ searchParams }: { searchParams: { state?: string } }) {
  const state = searchParams.state
  const notice: LoginNotice = state === 'cancelled' || state === 'demo-expired' ? state : null
  return <LoginForm notice={notice} openDemo={state === 'code'} />
}
