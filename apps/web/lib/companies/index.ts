// The Companies contract: the one import the pages and routes use.
//
// Reads come from page-data.ts (the wall, one employer, search inside its roles) and directory.ts (search by name).
// Writes are the add and follow flows. Nothing here calls a model.

export { companiesPage, companyPage, companyRoles, PAGE_SIZE } from './page-data'
export type { Checked, CompaniesHeader, CompaniesPage, CompaniesPageOpts, CompanyPage, CompanyRow, KeptRole, RoleHit } from './page-data'
export { getEmployer, searchCompanies } from './directory'
export type { DirectoryRow, NotChecked } from './directory'
export { addCompany } from './add-link'
export type { AddBy, AddFailure, AddResult } from './add-link'
export { followEmployer } from './follow'
