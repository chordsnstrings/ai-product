-- 0102 · Platform integrity: lifecycle restore, Brand Brain versions, claim scope normalisation, learning
-- revision, production resume/outage bookkeeping, and RLS for global tables that carry tenant rows.

-- ───────────── Workspace lifecycle (plan 02 §2, §7) ─────────────
-- Cancelling a scheduled deletion returns the workspace to the state it had before (not always CANCELLED).
alter table workspaces add column state_before_purge text check (state_before_purge in
  ('PROVISIONAL','ACTIVE_FREE','ACTIVE_PAID','PAST_DUE','CANCELLED'));

-- ───────────── Claim scope (standard §17, §43) ─────────────
-- Web and staff approvals stored lowercase shorthands ('meta', 'tiktok', …) while the render check compares
-- canonical platform codes, so approved claims never matched. Normalise to upper-case canonical values and
-- expand shorthands (META = Instagram Reels + Facebook feed). Markets are upper-case codes.
update claims c set allowed_platforms = coalesce((
    select array_agg(distinct x order by x) from (
      select unnest(case upper(btrim(p))
        when 'META' then array['INSTAGRAM_REELS', 'FACEBOOK_FEED']
        when 'INSTAGRAM' then array['INSTAGRAM_REELS']
        when 'REELS' then array['INSTAGRAM_REELS']
        when 'FACEBOOK' then array['FACEBOOK_FEED']
        when 'FEED' then array['FACEBOOK_FEED']
        when 'YOUTUBE_SHORTS' then array['YOUTUBE']
        else array[upper(btrim(p))] end) as x
      from unnest(c.allowed_platforms) p) s), '{}')
  where exists (select 1 from unnest(c.allowed_platforms) p
                where p <> upper(btrim(p)) or upper(btrim(p)) in ('META','INSTAGRAM','REELS','FACEBOOK','FEED','YOUTUBE_SHORTS'));
update claims c set allowed_markets = array(select distinct upper(btrim(m)) from unnest(c.allowed_markets) m)
  where exists (select 1 from unnest(c.allowed_markets) m where m <> upper(btrim(m)));
