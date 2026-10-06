// The health report is for whoever runs the deployment, the account whose id is
// OWNER_USER_ID, not for every signed-in person. Unset means nobody sees it in
// the app; the daily check still stores it.
// ponytail: K7's isOwner(userId) reads the same variable. The rebase on main deletes this file for it.

export function isOpsOwner(userId: string | null | undefined): boolean {
  const owner = process.env.OWNER_USER_ID?.trim()
  return Boolean(owner && userId && userId === owner)
}
