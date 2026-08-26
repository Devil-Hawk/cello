// Barrel for the demo-workspace fixture.
//
// The fixture is deliberately split by subject (persona / companies / jobs /
// contacts / pipeline) rather than by table: someone adding a company should
// not have to scroll past forty job postings, and someone tuning the match-score
// spread should not have to read a resume. seed-demo.ts is the only consumer
// that needs all of it at once.

export * from './ids'
export * from './persona'
export * from './companies'
export * from './jobs'
export * from './contacts'
export * from './pipeline'
