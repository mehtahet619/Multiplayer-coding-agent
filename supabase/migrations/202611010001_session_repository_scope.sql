-- Persist the source branch and optional subdirectory selected for each coding session.
-- Safe to run repeatedly after the initial schema migration has created public.sessions.
do $$
begin
  if to_regclass('public.sessions') is null then
    raise exception 'public.sessions is missing. Apply 202610270001_initial_schema.sql first.';
  end if;
end $$;

alter table public.sessions
  add column if not exists base_branch text,
  add column if not exists repository_path text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sessions_repository_path_safe'
      and conrelid = 'public.sessions'::regclass
  ) then
    alter table public.sessions
      add constraint sessions_repository_path_safe
      check (
        repository_path is null
        or (
          repository_path !~ '(^|/)\\.\\.(/|$)'
          and repository_path !~ '(^|/)\\.(/|$)'
          and left(repository_path, 1) <> '/'
        )
      );
  end if;
end $$;
