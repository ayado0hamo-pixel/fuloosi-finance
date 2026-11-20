-- Allow spending with an explicit currency and no linked account.
-- Existing account-linked entries retain their currency and balances.
begin;
set local lock_timeout = '5s';
alter table public.entries add column currency text;
update public.entries e set currency = a.currency from public.accounts a where e.account_id = a.id and e.user_id = a.user_id;
alter table public.entries alter column currency set not null;
alter table public.entries add constraint entries_currency_check check (currency in ('IQD', 'JOD', 'USD'));
alter table public.entries alter column account_id drop not null;
alter table public.entries add constraint entries_unlinked_expense_check
  check (account_id is not null or (kind = 'expense' and category <> 'تسوية رصيد'));

create function public.fuloosi_entry_currency() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare linked_currency text;
begin
  if new.account_id is null then
    if new.currency is null or new.kind <> 'expense' or new.category = 'تسوية رصيد' then
      raise exception 'An unlinked entry must be a spending expense with currency';
    end if;
  else
    select a.currency into linked_currency from public.accounts a
      where a.id = new.account_id and a.user_id = new.user_id;
    if linked_currency is null then raise exception 'Account does not belong to the entry owner'; end if;
    if new.currency is null then new.currency := linked_currency; end if;
    if new.currency <> linked_currency then raise exception 'Entry currency must match account currency'; end if;
  end if;
  return new;
end $$;
create trigger entries_currency before insert or update on public.entries
  for each row execute function public.fuloosi_entry_currency();
revoke all on function public.fuloosi_entry_currency() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fuloosi_import_missing(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
         or old_e.currency is distinct from coalesce(e ->> 'currency', (select currency from public.accounts where id = (e ->> 'account_id')::uuid and user_id = who))
         or old_e.kind is distinct from e ->> 'kind'
         or old_e.amount is distinct from (e ->> 'amount')::numeric
         or old_e.category is distinct from e ->> 'category'
         or old_e.note is distinct from e ->> 'note'
         or old_e.occurred_on is distinct from (e ->> 'occurred_on')::date then
        raise exception 'Entry conflict; no records were imported';
      end if;
    else
      insert into public.entries(id, user_id, account_id, currency, kind, amount, category, note, occurred_on, created_at)
      values ((e ->> 'id')::uuid, who, (e ->> 'account_id')::uuid, e ->> 'currency', e ->> 'kind',
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
$function$
;
commit;

