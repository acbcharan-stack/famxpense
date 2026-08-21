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
alter table investments drop constraint if exists investments_investment_mode_check;
alter table investments add constraint investments_investment_mode_check
  check (investment_mode in ('lumpsum', 'sip'));

create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
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

create index if not exists expenses_profile_date_idx on expenses (profile_id, expense_date);
create index if not exists budgets_profile_month_idx on budgets (profile_id, month);
create index if not exists investments_start_date_idx on investments (start_date);
create index if not exists trades_trade_date_idx on trades (trade_date);

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

-- Private family app, no login screen: allow the anon key full access.
alter table profiles enable row level security;
alter table expenses enable row level security;
alter table budgets enable row level security;
alter table investments enable row level security;
alter table trades enable row level security;

drop policy if exists "allow all profiles" on profiles;
drop policy if exists "allow all expenses" on expenses;
drop policy if exists "allow all budgets" on budgets;
drop policy if exists "allow all investments" on investments;
drop policy if exists "allow all trades" on trades;

create policy "allow all profiles" on profiles for all using (true) with check (true);
create policy "allow all expenses" on expenses for all using (true) with check (true);
create policy "allow all budgets" on budgets for all using (true) with check (true);
create policy "allow all investments" on investments for all using (true) with check (true);
create policy "allow all trades" on trades for all using (true) with check (true);
