-- Store a settlement once. The debt direction offsets the open debt and has
-- the opposite effect on the linked wallet account.
alter table public.debt_entries
  add column settlement_account_id uuid,
  add constraint debt_entries_settlement_account_fkey
    foreign key (settlement_account_id, user_id) references public.accounts(id, user_id) on delete restrict;

create index debt_entries_settlement_account on public.debt_entries(settlement_account_id, user_id)
  where settlement_account_id is not null;

create function public.fuloosi_check_debt_settlement()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.settlement_account_id is not null or new.settlement_account_id is not null then
      raise exception 'لحفظ تصحيح التسديد، احذف التسديد وسجّله من جديد.';
    end if;
  elsif new.settlement_account_id is not null then
    perform 1 from public.accounts
      where id = new.settlement_account_id and user_id = new.user_id and currency = new.currency
      for share;
    if not found then
      raise exception 'اختار حساب بنفس عملة الدين.';
    end if;
  end if;
  return new;
end
$$;

revoke all on function public.fuloosi_check_debt_settlement() from public, anon, authenticated;

create trigger debt_entries_check_settlement before insert or update on public.debt_entries
  for each row execute function public.fuloosi_check_debt_settlement();

create function public.fuloosi_settle_debt(
  p_id uuid, p_person_id uuid, p_account_id uuid, p_currency text,
  p_direction text, p_amount numeric, p_occurred_on date
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  who uuid := auth.uid();
  existing public.debt_entries;
  net numeric;
begin
  if who is null then raise exception 'سجّل الدخول أولاً.'; end if;
  if p_id is null or p_person_id is null or p_account_id is null or p_occurred_on is null
     or p_currency is null or p_currency not in ('IQD', 'JOD', 'USD')
     or p_direction is null or p_direction not in ('owed_to_me', 'i_owe')
     or p_amount is null or p_amount <= 0 or p_amount > 1000000000000
     or p_amount <> round(p_amount, 3) then
    raise exception 'بيانات التسديد غير صالحة.';
  end if;

  -- Serialize payments, including retries, for the same owner.
  perform pg_advisory_xact_lock(hashtextextended(who::text, 0));
  select * into existing from public.debt_entries where id = p_id and user_id = who;
  if found then
    if existing.person_id = p_person_id and existing.settlement_account_id = p_account_id
       and existing.currency = p_currency and existing.direction = p_direction
       and existing.amount = p_amount and existing.occurred_on = p_occurred_on then
      return;
    end if;
    raise exception 'هذا التسديد مسجّل سابقاً. حدّث السجل وراجعه.';
  end if;

  select coalesce(sum(case when direction = 'owed_to_me' then amount else -amount end), 0)
    into net from public.debt_entries
    where user_id = who and person_id = p_person_id and currency = p_currency;
  if (case when p_direction = 'i_owe' then net else -net end) < p_amount then
    raise exception 'مبلغ التسديد أكبر من الرصيد المتبقي أو اتجاه الدين تغيّر.';
  end if;

  insert into public.debt_entries(id, user_id, person_id, settlement_account_id, direction, amount, currency, occurred_on)
  values (p_id, who, p_person_id, p_account_id, p_direction, p_amount, p_currency, p_occurred_on);
end
$$;

revoke all on function public.fuloosi_settle_debt(uuid, uuid, uuid, text, text, numeric, date) from public, anon;
grant execute on function public.fuloosi_settle_debt(uuid, uuid, uuid, text, text, numeric, date) to authenticated;

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
  if tg_table_name = 'budgets' then
    if new.category <> old.category then raise exception 'Budget category is immutable'; end if;
  end if;
  if tg_table_name = 'accounts' then
    if (new.currency <> old.currency or new.opening_balance <> old.opening_balance)
       and (
         exists (select 1 from public.entries where account_id = old.id)
         or exists (select 1 from public.transfers where from_account_id = old.id or to_account_id = old.id)
         or exists (select 1 from public.debt_entries where settlement_account_id = old.id)
       ) then
      raise exception 'Use an adjustment entry or transfer to change a balance with transactions';
    end if;
  end if;
  new.revision = old.revision + 1;
  return new;
end
$$;

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
         or old_d.settlement_account_id is distinct from (d ->> 'settlement_account_id')::uuid
         or old_d.direction is distinct from d ->> 'direction'
         or old_d.amount is distinct from (d ->> 'amount')::numeric
         or old_d.currency is distinct from d ->> 'currency'
         or old_d.note is distinct from d ->> 'note'
         or old_d.occurred_on is distinct from (d ->> 'occurred_on')::date then
        raise exception 'Debt entry conflict; no records were imported';
      end if;
    else
      insert into public.debt_entries(id, user_id, person_id, settlement_account_id, direction, amount, currency, note, occurred_on, created_at)
      values ((d ->> 'id')::uuid, who, (d ->> 'person_id')::uuid, (d ->> 'settlement_account_id')::uuid, d ->> 'direction',
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
