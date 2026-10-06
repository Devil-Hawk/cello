// The Lighthouse control: no shell, no rows, no mark. A page's numbers minus this
// page's numbers are what its layer costs (blueprint 4.0a caps that at 150 ms).
export default function BlankFixture() {
  return (
    <main id="main-content" className="mx-auto max-w-[640px] px-4 py-10">
      <h1 className="r-display">Blank</h1>
      <p className="r-body mt-4 text-r-ink-2">One heading and one paragraph, made up for a measure.</p>
    </main>
  )
}
