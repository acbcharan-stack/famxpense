import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://pxjryedxetccuxqclbjz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4anJ5ZWR4ZXRjY3V4cWNsYmp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzODcwODMsImV4cCI6MjEwMDk2MzA4M30.GtqP4UfllbMuq0FpG9Ct9Ira7YilEUOXT0RzRB1HZM0';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const PASSCODE_HASH = '0a95adbf8581859ae0cc477127abeaf4ad89916405c41855af8fbc482e1634e8';
const UNLOCK_KEY = 'famExpenseUnlocked';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function setupLock() {
  const overlay = document.getElementById('lockOverlay');
  const input = document.getElementById('lockInput');
  const error = document.getElementById('lockError');
  const submitBtn = document.getElementById('lockSubmit');

  if (localStorage.getItem(UNLOCK_KEY) === '1') {
    overlay.classList.add('hidden');
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const tryUnlock = async () => {
      const val = input.value.trim();
      if (!val) return;
      const hash = await sha256Hex(val);
      if (hash === PASSCODE_HASH) {
        localStorage.setItem(UNLOCK_KEY, '1');
        overlay.classList.add('hidden');
        resolve();
      } else {
        error.textContent = 'Incorrect passcode. Try again.';
        input.value = '';
        input.focus();
      }
    };
    submitBtn.addEventListener('click', tryUnlock);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
    input.focus();
  });
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

// Future value of a monthly SIP (annuity due — contribution at the start of each month).
export function sipFutureValue(monthlyAmount, annualReturnPct, months) {
  const p = Number(monthlyAmount) || 0;
  const n = Math.max(0, Math.round(Number(months) || 0));
  if (p <= 0 || n === 0) return 0;
  const i = (Number(annualReturnPct) || 0) / 100 / 12;
  if (i === 0) return p * n;
  return p * ((Math.pow(1 + i, n) - 1) / i) * (1 + i);
}

// A SIP's rate can change over time: sipHistory is [{ date, amount }, ...] sorted ascending,
// each entry's amount applying from its date until the next entry's date (or today).
export function sipInvestedToDate(sipHistory, asOf = new Date()) {
  if (!Array.isArray(sipHistory) || sipHistory.length === 0) return 0;
  const sorted = [...sipHistory].sort((a, b) => a.date.localeCompare(b.date));
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const periodStart = sorted[i].date;
    if (new Date(periodStart + 'T00:00:00') > asOf) break;
    const periodEndDate = i + 1 < sorted.length ? new Date(sorted[i + 1].date + 'T00:00:00') : asOf;
    const months = monthsBetween(periodStart, periodEndDate > asOf ? asOf : periodEndDate);
    total += (Number(sorted[i].amount) || 0) * months;
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

// Projected value `years` from now: existing corpus grows at the expected return, and — for
// SIPs — contributions keep going at the current monthly rate for the projection horizon.
export function investmentProjectedValue(inv, years) {
  const grown = projectedValue(investedAmount(inv), inv.annual_return, years);
  if (inv.investment_mode === 'sip') {
    const futureContributions = sipFutureValue(sipCurrentRate(inv.sip_history), inv.annual_return, (Number(years) || 0) * 12);
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
