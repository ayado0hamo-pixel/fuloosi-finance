-- Apply ONLY to the newly created, dedicated Fuloosi Supabase project.
-- Deliberately fails, with a full rollback, if these tables already exist.
begin;
create table public.accounts (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(name) between 1 and 100),
 currency text not null check(currency in ('IQD','JOD','USD')),
 opening_balance numeric(20,3) not null default 0 check(abs(opening_balance)<=1e12),
 created_at timestamptz not null default now(), revision bigint not null default 1,
 unique(user_id,name,currency), unique(id,user_id)
);
create table public.entries (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 account_id uuid not null,
 kind text not null check(kind in ('expense','income','adjustment')),
 amount numeric(20,3) not null check(amount>0 and amount<=1e12),
 category text not null default 'أخرى' check(length(category)<=200),
 note text not null default '' check(length(note)<=2000),
 occurred_on date not null default current_date,
 created_at timestamptz not null default now(), revision bigint not null default 1,
 foreign key(account_id,user_id) references public.accounts(id,user_id) on delete restrict
);
create table public.settings (
 user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
 iqd_per_usd numeric(18,5) not null default 1679 check(iqd_per_usd>0 and iqd_per_usd<=1e9),
 jod_per_usd numeric(18,5) not null default .709 check(jod_per_usd>0 and jod_per_usd<=1e9),
 revision bigint not null default 1
);
create index entries_user_date on public.entries(user_id,occurred_on desc);
create index entries_account on public.entries(account_id,user_id);
alter table public.accounts enable row level security;
alter table public.entries enable row level security;
alter table public.settings enable row level security;
revoke all on public.accounts,public.entries,public.settings from anon;
grant select,insert,update,delete on public.accounts,public.entries,public.settings to authenticated;
create policy accounts_owner on public.accounts for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
create policy entries_owner on public.entries for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
create policy settings_owner on public.settings for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));

create function public.fuloosi_revision() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.user_id<>old.user_id then raise exception 'Owner is immutable'; end if;
 if tg_table_name in ('accounts','entries') then
  if new.id<>old.id or new.created_at<>old.created_at then raise exception 'Identity is immutable'; end if;
 end if;
 if tg_table_name='accounts' then
  if (new.currency<>old.currency or new.opening_balance<>old.opening_balance) and exists(select 1 from public.entries where account_id=old.id) then
   raise exception 'Use an adjustment entry to change a balance with transactions';
  end if;
 end if;
 new.revision=old.revision+1; return new;
end $$;
create trigger accounts_revision before update on public.accounts for each row execute function public.fuloosi_revision();
create trigger entries_revision before update on public.entries for each row execute function public.fuloosi_revision();
create trigger settings_revision before update on public.settings for each row execute function public.fuloosi_revision();
revoke all on function public.fuloosi_revision() from public,anon,authenticated;

-- One statement provides a consistent snapshot without the REST row-count cap.
create function public.fuloosi_snapshot() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
  'accounts',coalesce((select jsonb_agg(a) from public.accounts a),'[]'::jsonb),
  'entries',coalesce((select jsonb_agg(e) from public.entries e),'[]'::jsonb),
  'settings',(select to_jsonb(s) from public.settings s where s.user_id=auth.uid())
 );
$$;
revoke all on function public.fuloosi_snapshot() from public,anon;
grant execute on function public.fuloosi_snapshot() to authenticated;

-- Atomic, insert-only migration. Any conflicting record aborts the whole call.
create function public.fuloosi_import_missing(payload jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare who uuid:=auth.uid(); a jsonb; e jsonb; old_a public.accounts; old_e public.entries; ac integer:=0; ec integer:=0;
begin
 if who is null then raise exception 'Authentication required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(who::text,0));
 if jsonb_typeof(payload->'accounts') is distinct from 'array' or jsonb_typeof(payload->'entries') is distinct from 'array' then raise exception 'Invalid backup'; end if;
 for a in select value from jsonb_array_elements(payload->'accounts') loop
  select * into old_a from public.accounts where id=(a->>'id')::uuid;
  if found then
   if old_a.name is distinct from a->>'name' or old_a.currency is distinct from a->>'currency' or old_a.opening_balance is distinct from (a->>'opening_balance')::numeric then raise exception 'Account conflict; no records were imported'; end if;
  else
   insert into public.accounts(id,user_id,name,currency,opening_balance) values((a->>'id')::uuid,who,a->>'name',a->>'currency',(a->>'opening_balance')::numeric); ac:=ac+1;
  end if;
 end loop;
 for e in select value from jsonb_array_elements(payload->'entries') loop
  select * into old_e from public.entries where id=(e->>'id')::uuid;
  if found then
   if old_e.account_id is distinct from (e->>'account_id')::uuid or old_e.kind is distinct from e->>'kind' or old_e.amount is distinct from (e->>'amount')::numeric or old_e.category is distinct from e->>'category' or old_e.note is distinct from e->>'note' or old_e.occurred_on is distinct from (e->>'occurred_on')::date then raise exception 'Entry conflict; no records were imported'; end if;
  else
   insert into public.entries(id,user_id,account_id,kind,amount,category,note,occurred_on,created_at) values((e->>'id')::uuid,who,(e->>'account_id')::uuid,e->>'kind',(e->>'amount')::numeric,e->>'category',e->>'note',(e->>'occurred_on')::date,coalesce((e->>'created_at')::timestamptz,now())); ec:=ec+1;
  end if;
 end loop;
 insert into public.settings(user_id,iqd_per_usd,jod_per_usd) values(who,(payload->'settings'->>'iqd_per_usd')::numeric,(payload->'settings'->>'jod_per_usd')::numeric) on conflict(user_id) do nothing;
 return jsonb_build_object('accounts',ac,'entries',ec);
end $$;
revoke all on function public.fuloosi_import_missing(jsonb) from public,anon;
grant execute on function public.fuloosi_import_missing(jsonb) to authenticated;
commit;
