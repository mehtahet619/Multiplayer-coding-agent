-- Multiplayer Coding Agent: durable, user-owned workspace data.
-- Apply with Supabase CLI: supabase db push
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Shared coding session' check (char_length(title) between 1 and 120),
  status text not null default 'idle' check (status in ('idle','running','paused','cancelled','completed','failed')),
  repository text check (repository is null or repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  branch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sessions_owner_created_idx on public.sessions(owner_id, created_at desc);

create table if not exists public.session_instructions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 8000),
  created_at timestamptz not null default now()
);
create index if not exists session_instructions_session_idx on public.session_instructions(session_id, created_at);

create table if not exists public.session_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  seq bigint not null,
  type text not null,
  actor_type text not null check (actor_type in ('user','agent','system')),
  actor_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(session_id, seq)
);
create index if not exists session_events_session_seq_idx on public.session_events(session_id, seq);

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_auth_user();

alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.session_instructions enable row level security;
alter table public.session_events enable row level security;

drop policy if exists "Users can read their profile" on public.profiles;
create policy "Users can read their profile" on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists "Users can update their profile" on public.profiles;
create policy "Users can update their profile" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "Users can manage their own sessions" on public.sessions;
create policy "Users can manage their own sessions" on public.sessions for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists "Users can manage instructions for their sessions" on public.session_instructions;
create policy "Users can manage instructions for their sessions" on public.session_instructions for all to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.sessions s where s.id = session_id and s.owner_id = (select auth.uid())))
with check (owner_id = (select auth.uid()) and exists (select 1 from public.sessions s where s.id = session_id and s.owner_id = (select auth.uid())));

drop policy if exists "Users can read events for their sessions" on public.session_events;
create policy "Users can read events for their sessions" on public.session_events for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.sessions s where s.id = session_id and s.owner_id = (select auth.uid())));

drop policy if exists "Users can append events to their own sessions" on public.session_events;
create policy "Users can append events to their own sessions" on public.session_events for insert to authenticated
with check (owner_id = (select auth.uid()) and exists (select 1 from public.sessions s where s.id = session_id and s.owner_id = (select auth.uid())));
