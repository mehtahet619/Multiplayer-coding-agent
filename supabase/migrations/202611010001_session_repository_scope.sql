-- Persist the source branch and optional subdirectory selected for each coding session.
alter table public.sessions
  add column if not exists base_branch text,
  add column if not exists repository_path text;

alter table public.sessions
  add constraint sessions_repository_path_safe
  check (
    repository_path is null
    or (
      repository_path !~ '(^|/)\.\.(/|$)'
      and repository_path !~ '(^|/)\.(/|$)'
      and left(repository_path, 1) <> '/'
    )
  );
