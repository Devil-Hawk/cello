import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

const publicRoutes = ['/login', '/auth/callback']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // /agent was folded into /copilot's runs panel. A page-level redirect()
  // in app/(app)/agent/page.tsx only fires client-side once React mounts
  // (its parent layout is a client component that streams a 200 first), so
  // plain HTTP clients (curl, old bookmarks with no JS) never leave /agent.
  // Redirect here instead — middleware runs before any rendering and always
  // returns a real 307.
  if (pathname === '/agent') {
    const url = request.nextUrl.clone()
    url.pathname = '/copilot'
    return NextResponse.redirect(url)
  }

  const { response, user } = await updateSession(request)

  // Allow public routes; API routes return their own 401s
  if (publicRoutes.some(route => pathname.startsWith(route)) || pathname.startsWith('/api')) {
    return response
  }

  // Redirect unauthenticated users to login
  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
