-- Customer sign-in (plan 03 Part C / P6, standard §34, plan 05 §3). Global identity tables only: no new tables,
-- so the RLS registry is unchanged.

-- OAuth: the flow is bound to the browser that started it (a random value in an HttpOnly cookie; its hash here),
-- so a callback URL delivered to someone else can't sign them in (login CSRF). A 'link' flow adds the provider
-- identity to an already signed-in user from Profile instead of signing in.
alter table oauth_states
  add column binding_hash text,
  add column link_user_id uuid references users(id) on delete cascade;

-- Magic links: who consumed a link and with which session ("Already signed in" on a second click in the same
-- browser), and a hashed handle the requesting tab polls to learn the link was used on another device.
alter table magic_links
  add column consumed_user_id uuid references users(id) on delete set null,
  add column consumed_session_id uuid references sessions(id) on delete set null,
  add column pending_handle_hash text;
create unique index magic_links_pending_handle on magic_links (pending_handle_hash) where pending_handle_hash is not null;

-- Users: optional password (Argon2id, standard §34); Terms/Privacy acceptance at account creation (plan 03 P6
-- "acceptance logged by the action and timestamp"); the post-purchase passkey prompt's dismissal (plan 06 Phase 3).
alter table users
  add column password_hash text,
  add column password_set_at timestamptz,
  add column terms_accepted_at timestamptz,
  add column terms_version text,
  add column privacy_version text,
  add column terms_method text,
  add column passkey_prompt_dismissed_at timestamptz;

-- Sessions are the sign-in history staff read (plan 05 §3 "login history"): record how each one signed in.
alter table sessions add column method text check (method in ('magic_link','google','apple','passkey','password'));
create index sessions_user_created on sessions (user_id, created_at desc);

alter table login_attempts drop constraint login_attempts_method_check;
alter table login_attempts add constraint login_attempts_method_check check (method in ('magic_link','passkey','google','apple','password'));
