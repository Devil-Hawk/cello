// Old pages with no new home yet. The account menu lists them so nothing
// becomes unreachable (directive 22). The package that re-homes a page removes
// its line: What is working goes with Applications, Notifications with Today,
// Demo access with Settings.
export const older: Array<{ label: string; href: string }> = [
  { label: 'What is working', href: '/insights' },
  { label: 'Demo access', href: '/settings/access' },
]
