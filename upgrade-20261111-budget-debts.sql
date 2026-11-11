-- Additive upgrade for the dedicated Fuloosi project.
-- It creates new tables and a new settings column; it never deletes or replaces existing rows.
begin;

alter table public.settings
  add column monthly_budget_jod numeric(18,3) not null default 600
  check (monthly_budget_jod >= 0 and monthly_budget_jod <= 1000000000);

create table public.budgets (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category text not null check (length(category) between 1 and 200),
  monthly_limit_jod numeric(18,3) not null default 0 check (monthly_limit_jod >= 0 and monthly_limit_jod <= 1000000000),
  revision bigint not null default 1,
  primary key (user_id, category)
);

create table public.debt_people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  created_at timestamptz not null default now(),
  revision bigint not null default 1,
  unique (user_id, name),
  unique (id, user_id)
);

create table public.debt_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  person_id uuid not null,
  direction text not null check (direction in ('owed_to_me', 'i_owe')),
  amount numeric(20,3) not null check (amount > 0 and amount <= 1000000000000),
  currency text not null check (currency in ('IQD', 'JOD', 'USD')),
  note text not null default '' check (length(note) <= 2000),
  occurred_on date not null default current_date,
  created_at timestamptz not null default now(),
  revision bigint not null default 1,
  foreign key (person_id, user_id) references public.debt_people(id, user_id) on delete restrict
);

create index debt_people_user on public.debt_people(user_id);
create index debt_entries_user_date on public.debt_entries(user_id, occurred_on desc);
create index debt_entries_person on public.debt_entries(person_id, user_id);

alter table public.budgets enable row level security;
alter table public.debt_people enable row level security;
alter table public.debt_entries enable row level security;

revoke all on public.budgets, public.debt_people, public.debt_entries from anon;
grant select, insert, update, delete on public.budgets, public.debt_people, public.debt_entries to authenticated;

create policy budgets_owner on public.budgets for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy debt_people_owner on public.debt_people for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy debt_entries_owner on public.debt_entries for all to authenticated
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
  if tg_table_name in ('accounts', 'entries', 'debt_people', 'debt_entries') then
    if new.id <> old.id or new.created_at <> old.created_at then raise exception 'Identity is immutable'; end if;
  end if;
  if tg_table_name = 'budgets' and new.category <> old.category then
    raise exception 'Budget category is immutable';
  end if;
  if tg_table_name = 'accounts' then
    if (new.currency <> old.currency or new.opening_balance <> old.opening_balance)
       and exists (select 1 from public.entries where account_id = old.id) then
      raise exception 'Use an adjustment entry to change a balance with transactions';
    end if;
  end if;
  new.revision = old.revision + 1;
  return new;
end
$$;

create trigger budgets_revision before update on public.budgets
  for each row execute function public.fuloosi_revision();
create trigger debt_people_revision before update on public.debt_people
  for each row execute function public.fuloosi_revision();
create trigger debt_entries_revision before update on public.debt_entries
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
    'budgets', coalesce((select jsonb_agg(b) from public.budgets b where b.user_id = auth.uid()), '[]'::jsonb),
    'debt_people', coalesce((select jsonb_agg(p) from public.debt_people p where p.user_id = auth.uid()), '[]'::jsonb),
    'debt_entries', coalesce((select jsonb_agg(d) from public.debt_entries d where d.user_id = auth.uid()), '[]'::jsonb),
    'settings', (select to_jsonb(s) from public.settings s where s.user_id = auth.uid())
  );
$$;

revoke all on function public.fuloosi_snapshot() from public, anon;
grant execute on function public.fuloosi_snapshot() to authenticated;

create or replace function public.fuloosi_import_missing(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  who uuid := auth.uid();
  a jsonb; e jsonb; b jsonb; p jsonb; d jsonb;
  old_a public.accounts; old_e public.entries; old_b public.budgets;
  old_p public.debt_people; old_d public.debt_entries;
  ac integer := 0; ec integer := 0; bc integer := 0; pc integer := 0; dc integer := 0;
begin
  if who is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(who::text, 0));
  if jsonb_typeof(payload -> 'accounts') is distinct from 'array'
     or jsonb_typeof(payload -> 'entries') is distinct from 'array' then
    raise exception 'Invalid backup';
  end if;

  for a in select value from jsonb_array_elements(payload -> 'accounts') loop
    select * into old_a from public.accounts where id = (a ->> 'id')::uuid;
    if found then
      if old_a.name is distinct from a ->> 'name'
         or old_a.currency is distinct from a ->> 'currency'
         or old_a.opening_balance is distinct from (a ->> 'opening_balance')::numeric then
        raise exception 'Account conflict; no records were imported';
      end if;
    else
      insert into public.accounts(id, user_id, name, currency, opening_balance)
      values ((a ->> 'id')::uuid, who, a ->> 'name', a ->> 'currency', (a ->> 'opening_balance')::numeric);
      ac := ac + 1;
    end if;
  end loop;

  for e in select value from jsonb_array_elements(payload -> 'entries') loop
    select * into old_e from public.entries where id = (e ->> 'id')::uuid;
    if found then
      if old_e.account_id is distinct from (e ->> 'account_id')::uuid
         or old_e.kind is distinct from e ->> 'kind'
         or old_e.amount is distinct from (e ->> 'amount')::numeric
         or old_e.category is distinct from e ->> 'category'
         or old_e.note is distinct from e ->> 'note'
         or old_e.occurred_on is distinct from (e ->> 'occurred_on')::date then
        raise exception 'Entry conflict; no records were imported';
      end if;
    else
      insert into public.entries(id, user_id, account_id, kind, amount, category, note, occurred_on, created_at)
      values ((e ->> 'id')::uuid, who, (e ->> 'account_id')::uuid, e ->> 'kind',
              (e ->> 'amount')::numeric, e ->> 'category', e ->> 'note',
              (e ->> 'occurred_on')::date, coalesce((e ->> 'created_at')::timestamptz, now()));
      ec := ec + 1;
    end if;
  end loop;

  for b in select value from jsonb_array_elements(coalesce(payload -> 'budgets', '[]'::jsonb)) loop
    select * into old_b from public.budgets where user_id = who and category = b ->> 'category';
    if found then
      if old_b.monthly_limit_jod is distinct from (b ->> 'monthly_limit_jod')::numeric then
        raise exception 'Budget conflict; no records were imported';
      end if;
    else
      insert into public.budgets(user_id, category, monthly_limit_jod)
      values (who, b ->> 'category', (b ->> 'monthly_limit_jod')::numeric);
      bc := bc + 1;
    end if;
  end loop;

  for p in select value from jsonb_array_elements(coalesce(payload -> 'debt_people', '[]'::jsonb)) loop
    select * into old_p from public.debt_people where id = (p ->> 'id')::uuid;
    if found then
      if old_p.name is distinct from p ->> 'name' then raise exception 'Debt person conflict; no records were imported'; end if;
    else
      insert into public.debt_people(id, user_id, name, created_at)
      values ((p ->> 'id')::uuid, who, p ->> 'name', coalesce((p ->> 'created_at')::timestamptz, now()));
      pc := pc + 1;
    end if;
  end loop;

  for d in select value from jsonb_array_elements(coalesce(payload -> 'debt_entries', '[]'::jsonb)) loop
    select * into old_d from public.debt_entries where id = (d ->> 'id')::uuid;
    if found then
      if old_d.person_id is distinct from (d ->> 'person_id')::uuid
         or old_d.direction is distinct from d ->> 'direction'
         or old_d.amount is distinct from (d ->> 'amount')::numeric
         or old_d.currency is distinct from d ->> 'currency'
         or old_d.note is distinct from d ->> 'note'
         or old_d.occurred_on is distinct from (d ->> 'occurred_on')::date then
        raise exception 'Debt entry conflict; no records were imported';
      end if;
    else
      insert into public.debt_entries(id, user_id, person_id, direction, amount, currency, note, occurred_on, created_at)
      values ((d ->> 'id')::uuid, who, (d ->> 'person_id')::uuid, d ->> 'direction',
              (d ->> 'amount')::numeric, d ->> 'currency', d ->> 'note',
              (d ->> 'occurred_on')::date, coalesce((d ->> 'created_at')::timestamptz, now()));
      dc := dc + 1;
    end if;
  end loop;

  insert into public.settings(user_id, iqd_per_usd, jod_per_usd, monthly_budget_jod)
  values (
    who,
    (payload -> 'settings' ->> 'iqd_per_usd')::numeric,
    (payload -> 'settings' ->> 'jod_per_usd')::numeric,
    coalesce((payload -> 'settings' ->> 'monthly_budget_jod')::numeric, 600)
  )
  on conflict (user_id) do nothing;

  return jsonb_build_object('accounts', ac, 'entries', ec, 'budgets', bc, 'debt_people', pc, 'debt_entries', dc);
end
$$;

revoke all on function public.fuloosi_import_missing(jsonb) from public, anon;
grant execute on function public.fuloosi_import_missing(jsonb) to authenticated;

-- Insert-only defaults for existing users. Existing budget rows are never changed.
insert into public.budgets(user_id, category, monthly_limit_jod)
select u.id, defaults.category, defaults.monthly_limit_jod
from auth.users u
cross join (values
  ('🍔 أكل وشرب'::text, 0::numeric),
  ('🚗 مواصلات', 80),
  ('🛒 تسوق', 60),
  ('🏃🏻 طلعات', 0),
  ('📱 اشتراكات', 25),
  ('🏠 سكن', 210),
  ('🛍️ شوبنك', 0),
  ('💈 حلاقة', 33)
) as defaults(category, monthly_limit_jod)
on conflict (user_id, category) do nothing;

commit;
