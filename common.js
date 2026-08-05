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

export function sumInvested(investments) {
  return investments.reduce((s, inv) => s + Number(inv.amount), 0);
}

export function totalProjected(investments, years) {
  return investments.reduce((s, inv) => s + projectedValue(inv.amount, inv.annual_return, years), 0);
}
