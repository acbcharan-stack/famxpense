-- Family Expense Tracker — run this once in the Supabase SQL Editor
-- (Project: acb.charan account, https://pxjryedxetccuxqclbjz.supabase.co)

create extension if not exists pgcrypto;

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  emoji text not null default '🙂',
  color text not null default '#2a78d6',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  category text not null default 'Other',
  note text,
  expense_date date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  month date not null,
  amount numeric(10,2) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  unique (profile_id, month)
);

create table if not exists investments (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete set null,
  name text,
  type text not null,
  amount numeric(12,2) not null default 0 check (amount >= 0),
  annual_return numeric(5,2) not null default 0,
  start_date date not null default current_date,
  investment_mode text not null default 'lumpsum' check (investment_mode in ('lumpsum', 'sip')),
  sip_history jsonb,
  return_history jsonb,
  created_at timestamptz not null default now()
);

alter table investments add column if not exists name text;
alter table investments alter column amount set default 0;
alter table investments add column if not exists investment_mode text not null default 'lumpsum';
alter table investments add column if not exists sip_history jsonb;
alter table investments add column if not exists return_history jsonb;
alter table investments add column if not exists profile_id uuid references profiles(id) on delete set null;
alter table investments drop constraint if exists investments_investment_mode_check;
alter table investments add constraint investments_investment_mode_check
  check (investment_mode in ('lumpsum', 'sip'));

create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete set null,
  symbol text not null,
  quantity numeric(14,4),
  entry_price numeric(14,4),
  invested_amount numeric(12,2) not null default 0 check (invested_amount >= 0),
  trade_date date not null default current_date,
  period_value int not null default 1 check (period_value > 0),
  period_unit text not null default 'days' check (period_unit in ('days', 'weeks', 'months')),
  target_percent numeric(6,2) not null default 0,
  notes text,
  status text not null default 'open' check (status in ('open', 'closed')),
  exit_date date,
  exit_amount numeric(12,2),
  exit_price numeric(14,4),
  notified_at timestamptz,
  created_at timestamptz not null default now()
);

alter table trades add column if not exists notified_at timestamptz;
alter table trades add column if not exists profile_id uuid references profiles(id) on delete set null;

create table if not exists goals (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  target_amount numeric(12,2) not null check (target_amount > 0),
  target_date date,
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  created_at timestamptz not null default now()
);

create index if not exists expenses_profile_date_idx on expenses (profile_id, expense_date);
create index if not exists budgets_profile_month_idx on budgets (profile_id, month);
create index if not exists investments_start_date_idx on investments (start_date);
create index if not exists trades_trade_date_idx on trades (trade_date);
create index if not exists goals_profile_status_idx on goals (profile_id, status);

-- Seed exactly 4 profiles, only if the table is empty
insert into profiles (name, emoji, color, sort_order)
select v.name, v.emoji, v.color, v.sort_order
from (values
  ('Profile 1', '🧑', '#2a78d6', 1),
  ('Profile 2', '🧑‍🦱', '#eb6834', 2),
  ('Profile 3', '🧑‍🦳', '#1baf7a', 3),
  ('Profile 4', '🧑‍🎤', '#eda100', 4)
) as v(name, emoji, color, sort_order)
where not exists (select 1 from profiles);

-- Family app gated by Google Sign-In: only these signed-in emails may read/write anything.
-- Edit this list (and re-run) to add/remove family members.
create or replace function public.is_family_member()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email', '') in (
    'acb.charan@gmail.com',
    'acboopathy@gmail.com',
    'namca2000@gmail.com',
    'sudanboopathy72@gmail.com'
  );
$$;

alter table profiles enable row level security;
alter table expenses enable row level security;
alter table budgets enable row level security;
alter table investments enable row level security;
alter table trades enable row level security;
alter table goals enable row level security;

drop policy if exists "allow all profiles" on profiles;
drop policy if exists "allow all expenses" on expenses;
drop policy if exists "allow all budgets" on budgets;
drop policy if exists "allow all investments" on investments;
drop policy if exists "allow all trades" on trades;
drop policy if exists "family only profiles" on profiles;
drop policy if exists "family only expenses" on expenses;
drop policy if exists "family only budgets" on budgets;
drop policy if exists "family only investments" on investments;
drop policy if exists "family only trades" on trades;
drop policy if exists "family only goals" on goals;

create policy "family only profiles" on profiles for all using (is_family_member()) with check (is_family_member());
create policy "family only expenses" on expenses for all using (is_family_member()) with check (is_family_member());
create policy "family only budgets" on budgets for all using (is_family_member()) with check (is_family_member());
create policy "family only investments" on investments for all using (is_family_member()) with check (is_family_member());
create policy "family only trades" on trades for all using (is_family_member()) with check (is_family_member());
create policy "family only goals" on goals for all using (is_family_member()) with check (is_family_member());
