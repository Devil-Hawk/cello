-- K6, applied once the T26 measure shows the directory far along (the seed is verified in slices over days, so the
-- routines of 20261008060002 start first). From here a lead becomes a role only when traced to the employer's own
-- posting, else a count (lib/sources/trace-leads.ts). Applied sooner, leads at employers not yet verified stop becoming roles.

update public.instance_flags set "on" = true, set_by = 'migration 20261008060003', set_at = now() where key = 'directory_leads' and not "on";
