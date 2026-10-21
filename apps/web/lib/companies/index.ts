// The Companies contract: the one import the pages and routes use.
//
// Reads come from page-data.ts (the wall, one employer, search inside its roles) and directory.ts (search by name).
// Writes are the add and follow flows; findEmployer (Enter in the field) only searches and writes nothing. Nothing here calls a model.

export { companiesPage, companyPage, companyRoles, isUuid, PAGE_SIZE } from './page-data'
export type { Checked, CompaniesHeader, CompaniesPage, CompaniesPageOpts, CompanyPage, CompanyRow, KeptRole, RoleHit } from './page-data'
export { getEmployer, searchCompanies } from './directory'
export type { DirectoryRow, NotChecked } from './directory'
export { addCompany } from './add-link'
export type { AddBy, AddFailure, AddResult, AddStep } from './add-link'
export { findEmployer, realFindDeps } from './find'
export type { Candidate, FindResult, Rung } from './find'
export { followEmployer } from './follow'
