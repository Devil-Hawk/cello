# Security

Don't open a public issue for a vulnerability. Use GitHub's private vulnerability
reporting on this repo (Security tab, then "Report a vulnerability"). You'll get a
response within a few days.

Cello is self-hosted: there is no server of mine holding your data, so most classes
of disclosure only affect your own deployment. Still, treat anything touching
`lib/security`, `lib/access`, the spend chokepoints, or the demo lockdown as
security-sensitive. Those areas have invariant tests; a report that includes which
test *should* have caught the issue is a great report.
