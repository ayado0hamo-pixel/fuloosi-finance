-- Additive upgrade for transfers between Fuloosi accounts.
-- Existing accounts, expenses, budgets and debts are not changed.
begin;

create table public.transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  from_account_id uuid not null,
  to_account_id uuid not null,
  from_amount numeric(20,3) not null check (from_amount > 0 and from_amount <= 1000000000000),
  to_amount numeric(20,3) not null check (to_amount > 0 and to_amount <= 1000000000000),
  note text not null default '' check (length(note) <= 2000),
  occurred_on date not null default current_date,
  created_at timestamptz not null default now(),
  revision bigint not null default 1,
  check (from_account_id <> to_account_id),
  foreign key (from_account_id, user_id) references public.accounts(id, user_id) on delete restrict,
  foreign key (to_account_id, user_id) references public.accounts(id, user_id) on delete restrict
);

create index transfers_user_date on public.transfers(user_id, occurred_on desc);
create index transfers_from_account on public.transfers(from_account_id, user_id);
create index transfers_to_account on public.transfers(to_account_id, user_id);

alter table public.transfers enable row level security;
revoke all on public.transfers from anon;
grant select, insert, update, delete on public.transfers to authenticated;
create policy transfers_owner on public.transfers for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create or replace function public.fuloosi_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.user_id <> old.user_id then raise exception 'Owner is immutable'; end if;
  if tg_table_name in ('accounts', 'entries', 'transfers', 'debt_people', 'debt_entries') then
    if new.id <> old.id or new.created_at <> old.created_at then raise exception 'Identity is immutable'; end if;
  end if;
  if tg_table_name = 'budgets' and new.category <> old.category then
    raise exception 'Budget category is immutable';
  end if;
  if tg_table_name = 'accounts' then
    if (new.currency <> old.currency or new.opening_balance <> old.opening_balance)
       and (
         exists (select 1 from public.entries where account_id = old.id)
         or exists (select 1 from public.transfers where from_account_id = old.id or to_account_id = old.id)
       ) then
      raise exception 'Use an adjustment entry or transfer to change a balance with transactions';
    end if;
  end if;
  new.revision = old.revision + 1;
  return new;
end
$$;

create trigger transfers_revision before update on public.transfers
  for each row execute function public.fuloosi_revision();

create or replace function public.fuloosi_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(a) from public.accounts a where a.user_id = auth.uid()), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(e) from public.entries e where e.user_id = auth.uid()), '[]'::jsonb),
    'transfers', coalesce((select jsonb_agg(t) from public.transfers t where t.user_id = auth.uid()), '[]'::jsonb),
    'budgets', coalesce((select jsonb_agg(b) from public.budgets b where b.user_id = auth.uid()), '[]'::jsonb),
    'debt_people', coalesce((select jsonb_agg(p) from public.debt_people p where p.user_id = auth.uid()), '[]'::jsonb),
    'debt_entries', coalesce((select jsonb_agg(d) from public.debt_entries d where d.user_id = auth.uid()), '[]'::jsonb),
    'settings', (select to_jsonb(s) from public.settings s where s.user_id = auth.uid())
  );
$$;

revoke all on function public.fuloosi_snapshot() from public, anon;
grant execute on function public.fuloosi_snapshot() to authenticated;

commit;
