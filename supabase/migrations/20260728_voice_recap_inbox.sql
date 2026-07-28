-- Private inbox for validated voice recaps. Run through the Supabase SQL
-- editor or CLI. No table policy grants anonymous/public access.
create table if not exists public.voice_recap_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'applied', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz
);

alter table public.voice_recap_drafts enable row level security;

create policy "Users read only their own recap drafts"
on public.voice_recap_drafts for select to authenticated
using (auth.uid() = user_id);

create policy "Users can update only their own recap drafts"
on public.voice_recap_drafts for update to authenticated
using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists voice_recap_drafts_owner_pending_idx
on public.voice_recap_drafts (user_id, status, created_at desc);
