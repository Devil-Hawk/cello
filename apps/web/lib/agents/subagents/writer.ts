// lane-stub: K24a writer import
// The Writer moved to lib/workflows/writer.ts (K17: Writer to Reviewer and Scout are StateGraphs
// in lib/workflows). This re-export keeps chat's imports working until K24a moves them; the lane's
// final grep for lane-stub removes it.
export * from '@/lib/workflows/writer'
