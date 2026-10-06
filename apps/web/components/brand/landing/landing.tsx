import Link from 'next/link'
import { Mark } from '@/components/depth/mark'
import { Disclosure } from '@/components/ui/disclosure'
import { Key } from '@/components/ui/key'
import { ExampleToday } from './example-today'
import { COST, FAQ, NEEDS_A_COMPUTER, PROMISE, REFUSALS, REPO_URL, WHAT_IT_DOES } from './content'
import { login } from '@/lib/routes'

// The first screen a stranger sees (blueprint 4.1). The phone's first screen
// is the mark, the promise, one line of what Cello does, Get started and the
// demo code link. Everything else sits below it; on a laptop the example Today
// frame stands beside the promise.
export function Landing() {
  return (
    <div className="min-h-screen bg-r-ground font-r text-r-ink">
      <header className="mx-auto flex max-w-[1200px] items-center gap-3 px-4 py-4 sm:px-6">
        <Mark size={36} />
        <span className="r-title">Cello</span>
        <span className="flex-1" />
        <Key asChild variant="raised" className="hidden sm:inline-flex">
          <Link href={login.href}>Sign in</Link>
        </Key>
      </header>

      <main id="main-content" className="mx-auto max-w-[1200px] px-4 pb-20 sm:px-6">
        <section className="grid gap-10 pt-6 md:grid-cols-2 md:items-center md:gap-14 md:pt-14">
          <div>
            <h1 className="r-display">{PROMISE}</h1>
            <p className="r-body mt-5 max-w-[46ch] text-r-ink-2">{WHAT_IT_DOES}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Key asChild className="w-full sm:w-auto">
                <Link href={login.href}>Get started</Link>
              </Key>
              <Key asChild variant="ghost" className="w-full sm:w-auto">
                <Link href={`${login.href}?demo=code`}>Have a demo code?</Link>
              </Key>
            </div>
          </div>
          <div className="hidden md:block">
            <ExampleToday />
          </div>
        </section>

        <section className="mt-24 md:mt-28" aria-labelledby="refusals">
          <h2 id="refusals" className="r-section">
            What Cello will not do
          </h2>
          <div className="mt-6 grid gap-x-12 md:grid-cols-2">
            {REFUSALS.map((r) => (
              <Disclosure key={r.heading} title={r.heading}>
                <p className="r-body text-r-ink-2">{r.sentence}</p>
              </Disclosure>
            ))}
          </div>
        </section>

        <section className="mt-20 grid gap-6 md:grid-cols-2 md:gap-12">
          <p className="r-body text-r-ink-2">{COST}</p>
          <p className="r-body text-r-ink-2">{NEEDS_A_COMPUTER}</p>
        </section>

        <section className="mt-20" aria-labelledby="faq">
          <h2 id="faq" className="r-section">
            Questions
          </h2>
          <div className="mt-6 max-w-[760px]">
            {FAQ.map((f) => (
              <Disclosure key={f.q} title={f.q}>
                <p className="r-body text-r-ink-2">{f.a}</p>
              </Disclosure>
            ))}
          </div>
        </section>

        <footer className="mt-20 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-r-line pt-6">
          <a href={REPO_URL} className="r-body text-r-ink-2 underline underline-offset-4">
            Built in the open
          </a>
        </footer>
      </main>
    </div>
  )
}
