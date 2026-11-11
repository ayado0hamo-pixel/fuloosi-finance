-- Scope the category comparison to budget rows; other tables have no category field.
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
       ) then
      raise exception 'Use an adjustment entry or transfer to change a balance with transactions';
    end if;
  end if;
  new.revision = old.revision + 1;
  return new;
end
$$;
