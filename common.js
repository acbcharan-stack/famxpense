import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://pxjryedxetccuxqclbjz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4anJ5ZWR4ZXRjY3V4cWNsYmp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzODcwODMsImV4cCI6MjEwMDk2MzA4M30.GtqP4UfllbMuq0FpG9Ct9Ira7YilEUOXT0RzRB1HZM0';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Password auth gates the UI; RLS policies in schema.sql (is_family_member()) gate the
// data itself using this same list, so keep the two in sync. Only these 4 emails should
// ever have a Supabase Auth account (create them in the dashboard, not here — a password
// never belongs in source code).
export const ALLOWED_EMAILS = [
  'acb.charan@gmail.com',
  'acboopathy@gmail.com',
  'namca2000@gmail.com',
  'sudanboopathy72@gmail.com',
];

export function setupAuth() {
  const overlay = document.getElementById('authOverlay');
  const form = document.getElementById('authForm');
  const emailInput = document.getElementById('authEmail');
  const passwordInput = document.getElementById('authPassword');
  const submitBtn = document.getElementById('authSubmitBtn');
  const errorEl = document.getElementById('authError');

  return new Promise((resolve) => {
    let resolved = false;

    const handleSession = async (session) => {
      if (session && ALLOWED_EMAILS.includes(session.user.email)) {
        overlay.classList.add('hidden');
        if (!resolved) { resolved = true; resolve(); }
      } else if (session) {
        const deniedEmail = session.user.email;
        await sb.auth.signOut();
        if (errorEl) errorEl.textContent = `${deniedEmail} isn't on the family list.`;
        overlay.classList.remove('hidden');
      } else {
        overlay.classList.remove('hidden');
      }
    };

    sb.auth.onAuthStateChange((_event, session) => { handleSession(session); });
    sb.auth.getSession().then(({ data }) => handleSession(data.session));

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (errorEl) errorEl.textContent = '';
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || !password) return;

      submitBtn.disabled = true;
      const { error } = await sb.auth.signInWithPassword({ email, password });
      submitBtn.disabled = false;

      if (error) {
        if (errorEl) errorEl.textContent = 'Incorrect email or password.';
        passwordInput.value = '';
        passwordInput.focus();
      }
    });
  });
}

export async function signOut() {
  await sb.auth.signOut();
  window.location.reload();
}

// ---------- expenses / receipt scanning ----------

// The category list for the Add-expense dropdown and import validation. The
// parse-receipt edge function keeps its own copy — update both together.
export const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Housing/Rent', 'Utilities', 'Entertainment', 'Shopping', 'Health', 'Education', 'Savings & Investment', 'Other'];

// Downscale an image File to a JPEG data URL so receipt uploads stay small and fast.
// Smaller = faster upload and a quicker vision pass; ~1100px keeps text readable.
export async function fileToScaledJpeg(file, maxDim = 1100, quality = 0.8) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', quality);
}

// Send scaled screenshots to the parse-receipt edge function. Resolves to an array of
// parsed transaction objects (see that function for the shape); throws with a readable
// message on failure or after SCAN_TIMEOUT_MS so the UI never hangs indefinitely.
const SCAN_TIMEOUT_MS = 60000;

export async function scanReceipts(dataUrls) {
  const invoke = sb.functions.invoke('parse-receipt', { body: { images: dataUrls } });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timed out — try again with one clearer image')), SCAN_TIMEOUT_MS));

  const { data, error } = await Promise.race([invoke, timeout]);
  if (error) {
    let msg = error.message || 'Scan failed';
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch { /* keep the generic message */ }
    throw new Error(msg);
  }
  return Array.isArray(data?.transactions) ? data.transactions : [];
}

// ---------- date / money helpers ----------

export function pad(n) { return String(n).padStart(2, '0'); }
export function fmtDateISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
export function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

export function fmtMoney(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '-' : '') + '₹' + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Countries a foreign investment can be tagged with. Each entry's symbol is used only to
// *display* that investment's own amounts — there is no live exchange-rate conversion, so
// aggregate totals across investments in different currencies are a naive sum, not a real one.
export const COUNTRY_CURRENCIES = [
  { country: 'India', symbol: '₹', locale: 'en-IN' },
  { country: 'United States', symbol: '$', locale: 'en-US' },
  { country: 'United Kingdom', symbol: '£', locale: 'en-GB' },
  { country: 'Canada', symbol: 'C$', locale: 'en-CA' },
  { country: 'Australia', symbol: 'A$', locale: 'en-AU' },
  { country: 'Singapore', symbol: 'S$', locale: 'en-SG' },
  { country: 'United Arab Emirates', symbol: 'AED ', locale: 'en-AE' },
  { country: 'Germany', symbol: '€', locale: 'de-DE' },
  { country: 'Japan', symbol: '¥', locale: 'ja-JP' },
  { country: 'Switzerland', symbol: 'CHF ', locale: 'de-CH' },
];

export function currencyForCountry(country) {
  return COUNTRY_CURRENCIES.find(c => c.country === country) || COUNTRY_CURRENCIES[0];
}

export function fmtMoneyCountry(n, country) {
  const v = Number(n) || 0;
  const cur = currencyForCountry(country);
  return (v < 0 ? '-' : '') + cur.symbol + Math.abs(v).toLocaleString(cur.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function hexToRgba(hex, alpha) {
  const h = (hex || '#2a78d6').replace('#', '');
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- navigation ----------

const NAV_LINKS = [
  { page: 'expenses', href: 'index.html', emoji: '💸', label: 'Expenses' },
  { page: 'investments', href: 'investments.html', emoji: '💰', label: 'Investments' },
  { page: 'trades', href: 'trades.html', emoji: '📈', label: 'Trading' },
];

export function initSidebar(activePage) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const toggle = document.getElementById('menuToggle');
  if (!sidebar) return;

  sidebar.innerHTML = `
    <div class="sidebar-brand">💸 FamCalc</div>
    <nav class="sidebar-nav">
      ${NAV_LINKS.map(l => `
        <a class="nav-link${l.page === activePage ? ' active' : ''}" href="${l.href}">
          <span class="nav-emoji">${l.emoji}</span> ${l.label}
        </a>`).join('')}
    </nav>`;

  const closeSidebar = () => {
    sidebar.classList.remove('open');
    overlay?.classList.remove('open');
  };
  const openSidebar = () => {
    sidebar.classList.add('open');
    overlay?.classList.add('open');
  };

  toggle?.addEventListener('click', () => {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  });
  overlay?.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });
}

// ---------- theme ----------

export function applyStoredTheme() {
  const stored = localStorage.getItem('theme');
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.setAttribute('data-theme', stored);
  }
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const explicit = document.documentElement.getAttribute('data-theme');
  const effectiveDark = explicit ? explicit === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  btn.textContent = effectiveDark ? '☀️' : '🌙';
}

export function toggleTheme() {
  const explicit = document.documentElement.getAttribute('data-theme');
  const effectiveDark = explicit ? explicit === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = effectiveDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon();
}

// ---------- investments ----------

export const INVESTMENT_CATEGORY = 'Savings & Investment';
export const PROJECTION_MILESTONES = [5, 10, 20];

export function projectedValue(amount, annualReturnPct, years) {
  const r = Number(annualReturnPct) || 0;
  const t = Number(years) || 0;
  return Number(amount) * Math.pow(1 + r / 100, t);
}

// Whole months between an ISO start date and a target date (never negative).
export function monthsBetween(startDateStr, asOf = new Date()) {
  const start = new Date(startDateStr + 'T00:00:00');
  let months = (asOf.getFullYear() - start.getFullYear()) * 12 + (asOf.getMonth() - start.getMonth());
  if (asOf.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

// Future value of `months` *additional* monthly SIP contributions from today onward (an ordinary
// annuity — the first of these new contributions lands one month from now). Today's own
// contribution, if any, belongs to sipInvestedToDate instead and must not be counted here too.
export function sipFutureValue(monthlyAmount, annualReturnPct, months) {
  const p = Number(monthlyAmount) || 0;
  const n = Math.max(0, Math.round(Number(months) || 0));
  if (p <= 0 || n === 0) return 0;
  const i = (Number(annualReturnPct) || 0) / 100 / 12;
  if (i === 0) return p * n;
  return p * ((Math.pow(1 + i, n) - 1) / i);
}

// A SIP's rate can change over time: sipHistory is [{ date, amount }, ...] sorted ascending,
// each entry's amount applying from its date until the next entry's date (or today).
// SIP contributions land at the *start* of each period (an installment lands on the day the
// SIP — or a new rate — takes effect, not a month later), so the period currently in effect as
// of `asOf` counts one more installment (today's) than the whole months elapsed since it began.
export function sipInvestedToDate(sipHistory, asOf = new Date()) {
  if (!Array.isArray(sipHistory) || sipHistory.length === 0) return 0;
  const sorted = [...sipHistory].sort((a, b) => a.date.localeCompare(b.date));
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const periodStartStr = sorted[i].date;
    const periodStart = new Date(periodStartStr + 'T00:00:00');
    if (periodStart > asOf) break;
    const nextEntry = sorted[i + 1];
    const nextPeriodStart = nextEntry ? new Date(nextEntry.date + 'T00:00:00') : null;
    const isOpenAsOfToday = !nextPeriodStart || nextPeriodStart > asOf;
    const installments = isOpenAsOfToday
      ? monthsBetween(periodStartStr, asOf) + 1
      : monthsBetween(periodStartStr, nextPeriodStart);
    total += (Number(sorted[i].amount) || 0) * installments;
  }
  return total;
}

// The SIP amount currently in effect (most recent entry whose date has arrived).
export function sipCurrentRate(sipHistory, asOf = new Date()) {
  if (!Array.isArray(sipHistory) || sipHistory.length === 0) return 0;
  const active = sipHistory.filter(h => new Date(h.date + 'T00:00:00') <= asOf);
  if (active.length === 0) return 0;
  return Number(active.reduce((a, b) => (a.date > b.date ? a : b)).amount) || 0;
}

// Total invested so far: base/top-up amount + everything contributed through the SIP schedule.
export function investedAmount(inv) {
  if (inv.investment_mode === 'sip') {
    return (Number(inv.amount) || 0) + sipInvestedToDate(inv.sip_history);
  }
  return Number(inv.amount) || 0;
}

// An investment's expected return can be revised over time (e.g. rechecked monthly against
// actual performance): returnHistory is [{ date, rate }, ...]. Projections use the plain
// average of every recorded rate rather than just the latest one. Falls back to the flat
// annual_return column when no history has been recorded.
export function averageReturn(inv) {
  const history = inv.return_history;
  if (Array.isArray(history) && history.length > 0) {
    const sum = history.reduce((s, h) => s + (Number(h.rate) || 0), 0);
    return sum / history.length;
  }
  return Number(inv.annual_return) || 0;
}

// Projected value `years` from now: existing corpus grows at the (average) expected return, and
// — for SIPs — contributions keep going at the current monthly rate for the projection horizon.
export function investmentProjectedValue(inv, years) {
  const rate = averageReturn(inv);
  const grown = projectedValue(investedAmount(inv), rate, years);
  if (inv.investment_mode === 'sip') {
    const futureContributions = sipFutureValue(sipCurrentRate(inv.sip_history), rate, (Number(years) || 0) * 12);
    return grown + futureContributions;
  }
  return grown;
}

export function sumInvested(investments) {
  return investments.reduce((s, inv) => s + investedAmount(inv), 0);
}

export function totalProjected(investments, years) {
  return investments.reduce((s, inv) => s + investmentProjectedValue(inv, years), 0);
}

// What you'd actually walk away with from a given gross value, after the exit load (% on
// redemption), brokerage (%), and any flat brokerage fee are deducted. Missing fields cost nothing.
export function netInvestmentValue(inv, grossValue) {
  const pct = (Number(inv.exit_load_percent) || 0) + (Number(inv.brokerage_percent) || 0);
  const fee = Number(inv.brokerage_fee) || 0;
  const net = grossValue - (grossValue * pct / 100) - fee;
  return Math.max(0, net);
}

// The "actual" value `years` from now: the same growth model as investmentProjectedValue,
// net of exit load, brokerage %, and flat brokerage fee as if you exited at that point.
export function investmentActualValue(inv, years) {
  return netInvestmentValue(inv, investmentProjectedValue(inv, years));
}

export function totalActual(investments, years) {
  return investments.reduce((s, inv) => s + investmentActualValue(inv, years), 0);
}

// Groups investments by country so totals can be summed within a single currency instead of
// naively adding, say, dollars to rupees. India sorts first, then the rest alphabetically.
export function groupInvestmentsByCountry(investments) {
  const map = new Map();
  investments.forEach(inv => {
    const country = inv.country || 'India';
    if (!map.has(country)) map.set(country, []);
    map.get(country).push(inv);
  });
  const countries = [...map.keys()].sort((a, b) => {
    if (a === 'India') return -1;
    if (b === 'India') return 1;
    return a.localeCompare(b);
  });
  return countries.map(country => ({ country, investments: map.get(country) }));
}

// ---------- trades ----------

// The date by which the broker/tip said this trade should have hit its target percentage.
export function tradeTargetDate(trade) {
  const start = new Date(trade.trade_date + 'T00:00:00');
  const n = Number(trade.period_value) || 0;
  const d = new Date(start);
  if (trade.period_unit === 'weeks') d.setDate(d.getDate() + n * 7);
  else if (trade.period_unit === 'months') d.setMonth(d.getMonth() + n);
  else d.setDate(d.getDate() + n);
  return d;
}

// Whole days between today and a target date; negative once the date is in the past.
export function daysUntil(date, asOf = new Date()) {
  const a = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  const b = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((b - a) / 86400000);
}

// Money actually kept from an exit after the broker/AMC's exit load (a % fee on the
// redemption value) is deducted. Absent for trades with no exit load recorded.
export function netExitAmount(trade) {
  const exit = Number(trade.exit_amount) || 0;
  const loadPct = Number(trade.exit_load_percent) || 0;
  return exit - (exit * loadPct / 100);
}

// Realized gain for a closed trade, net of exit load, in money and in percent of the amount invested.
export function tradeGain(trade) {
  const invested = Number(trade.invested_amount) || 0;
  const amount = netExitAmount(trade) - invested;
  const percent = invested > 0 ? (amount / invested) * 100 : 0;
  return { amount, percent };
}

// Everything the UI needs to badge a trade: open/closed, on-track vs overdue, target hit or not.
export function tradeStatusInfo(trade, asOf = new Date()) {
  const targetDate = tradeTargetDate(trade);
  const daysLeft = daysUntil(targetDate, asOf);
  if (trade.status === 'closed') {
    const { amount, percent } = tradeGain(trade);
    return {
      closed: true,
      amount, percent,
      hitTarget: percent >= (Number(trade.target_percent) || 0),
      exitedEarly: trade.exit_date ? trade.exit_date < fmtDateISO(targetDate) : false,
      targetDate,
    };
  }
  return {
    closed: false,
    overdue: daysLeft < 0,
    daysLeft,
    targetDate,
  };
}

export function sumTradesInvested(trades) {
  return trades.reduce((s, t) => s + (Number(t.invested_amount) || 0), 0);
}

// What you stand to lose if a stop loss is hit: (entry price - stop loss price) x quantity.
// Needs quantity, entry price, and an enabled stop loss price to mean anything.
export function stopLossInfo(trade) {
  if (!trade.stop_loss_enabled || trade.stop_loss_price == null) return null;
  const qty = Number(trade.quantity);
  const entry = Number(trade.entry_price);
  const stopLoss = Number(trade.stop_loss_price);
  if (!qty || !entry || isNaN(stopLoss)) return null;
  const amount = (entry - stopLoss) * qty;
  const invested = Number(trade.invested_amount) || 0;
  const percent = invested > 0 ? (amount / invested) * 100 : 0;
  return { amount, percent };
}

// ---------- savings ----------

// Total saved so far for one savings row: for a recurring ("fixed monthly") plan, the optional
// one-time top-up plus everything the recurring schedule has contributed to date; for a
// one-time entry, just its amount. Mirrors investedAmount()'s SIP-vs-lumpsum split.
export function savingsAmountToDate(s, asOf = new Date()) {
  if (s.savings_mode === 'recurring') {
    return (Number(s.amount) || 0) + sipInvestedToDate(s.recurring_history, asOf);
  }
  return Number(s.amount) || 0;
}

export function sumSavings(savingsRows, asOf = new Date()) {
  return savingsRows.reduce((s, r) => s + savingsAmountToDate(r, asOf), 0);
}

// How much of `monthStart`'s calendar month should count as "spent" against budget for these
// savings rows: a one-time entry counts in the month of its saved_date; a recurring plan counts
// its installment for that month (once it has started), using whatever rate was in effect by
// month's end. Rows with count_in_budget === false (extra money, not from the regular budget)
// never count.
export function savingsMonthlyBudgetImpact(savingsRows, monthStart) {
  const monthEnd = addMonths(monthStart, 1);
  const monthStartISO = fmtDateISO(monthStart);
  const monthEndISO = fmtDateISO(monthEnd);
  const lastInstant = new Date(monthEnd.getTime() - 1);

  return savingsRows.reduce((sum, s) => {
    if (s.count_in_budget === false) return sum;
    if (s.savings_mode === 'recurring') {
      const history = Array.isArray(s.recurring_history) ? s.recurring_history : [];
      if (!history.length) return sum;
      const firstDate = new Date([...history].sort((a, b) => a.date.localeCompare(b.date))[0].date + 'T00:00:00');
      if (firstDate >= monthEnd) return sum;
      return sum + sipCurrentRate(history, lastInstant);
    }
    return (s.saved_date >= monthStartISO && s.saved_date < monthEndISO) ? sum + (Number(s.amount) || 0) : sum;
  }, 0);
}

// Same idea as savingsMonthlyBudgetImpact but for investments: a lump sum counts its amount in
// its start month, a SIP counts its current installment for any month from its start onward.
// Rows with count_in_budget === false never count.
export function investmentMonthlyBudgetImpact(inv, monthStart) {
  if (inv.count_in_budget === false) return 0;
  const monthEnd = addMonths(monthStart, 1);

  if (inv.investment_mode === 'sip') {
    const history = Array.isArray(inv.sip_history) ? inv.sip_history : [];
    if (!history.length) return 0;
    const firstDate = new Date([...history].sort((a, b) => a.date.localeCompare(b.date))[0].date + 'T00:00:00');
    if (firstDate >= monthEnd) return 0;
    return sipCurrentRate(history, new Date(monthEnd.getTime() - 1));
  }

  const start = new Date(inv.start_date + 'T00:00:00');
  return (start >= monthStart && start < monthEnd) ? (Number(inv.amount) || 0) : 0;
}

export function investmentsMonthlyBudgetImpact(investments, monthStart) {
  return investments.reduce((s, inv) => s + investmentMonthlyBudgetImpact(inv, monthStart), 0);
}

// Realized P&L across every closed trade, plus a win rate (share that hit their target %).
// ---------- goals ----------

// Cumulative (budget - spent) since a goal's creation, one month at a time. Months with no
// budget row for the profile contribute nothing (no leftover to speak of, not a deficit).
export function goalProgress(goalCreatedAt, budgetsForProfile, expensesForProfile) {
  const startMonth = startOfMonth(new Date(goalCreatedAt));
  let surplus = 0;
  budgetsForProfile.forEach(b => {
    const monthStart = new Date(b.month + 'T00:00:00');
    if (monthStart < startMonth) return;
    const monthEndISO = fmtDateISO(addMonths(monthStart, 1));
    const spent = expensesForProfile
      .filter(e => e.expense_date >= b.month && e.expense_date < monthEndISO)
      .reduce((s, e) => s + Number(e.amount), 0);
    surplus += Number(b.amount) - spent;
  });
  return surplus;
}

export function tradesSummary(trades) {
  const closed = trades.filter(t => t.status === 'closed');
  const investedClosed = sumTradesInvested(closed);
  const realizedGain = closed.reduce((s, t) => s + tradeGain(t).amount, 0);
  const realizedPercent = investedClosed > 0 ? (realizedGain / investedClosed) * 100 : 0;
  const wins = closed.filter(t => tradeStatusInfo(t).hitTarget).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
  const open = trades.filter(t => t.status === 'open');
  const openRisk = open.reduce((s, t) => {
    const info = stopLossInfo(t);
    return s + (info && info.amount > 0 ? info.amount : 0);
  }, 0);
  return {
    realizedGain, realizedPercent,
    closedCount: closed.length, winRate,
    openCount: open.length, openInvested: sumTradesInvested(open),
    openRisk,
  };
}
