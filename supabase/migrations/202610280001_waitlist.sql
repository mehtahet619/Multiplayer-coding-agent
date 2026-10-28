-- Public waitlist signups for the Multiplayer Agent launch.
create table if not exists public.waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now(),
  constraint waitlist_signups_email_format check (email = lower(trim(email)) and char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'),
  constraint waitlist_signups_email_unique unique (email)
);
alter table public.waitlist_signups enable row level security;
-- No public SELECT/UPDATE/DELETE policy: visitor email addresses remain private.
grant insert on public.waitlist_signups to anon, authenticated;

create policy "Anyone can join waitlist" on public.waitlist_signups for insert to anon, authenticated with check (email = lower(trim(email)) and char_length(email) <= 254);
