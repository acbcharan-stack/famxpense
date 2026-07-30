import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import * as XLSX from 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm';

const SUPABASE_URL = 'https://pxjryedxetccuxqclbjz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4anJ5ZWR4ZXRjY3V4cWNsYmp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzODcwODMsImV4cCI6MjEwMDk2MzA4M30.GtqP4UfllbMuq0FpG9Ct9Ira7YilEUOXT0RzRB1HZM0';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const PASSCODE_HASH = '0a95adbf8581859ae0cc477127abeaf4ad89916405c41855af8fbc482e1634e8';
const UNLOCK_KEY = 'famExpenseUnlocked';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function setupLock() {
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

const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Housing/Rent', 'Utilities', 'Entertainment', 'Shopping', 'Health', 'Education', 'Other'];

let profiles = [];
let currentMonth = startOfMonth(new Date());
let expenses = [];
let budgets = [];
let activeProfileFilter = 'all';
let selectedModalProfile = null;
let chartTableView = false;

// ---------- helpers ----------

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDateISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
function fmtMoney(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '-' : '') + '₹' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function hexToRgba(hex, alpha) {
  const h = (hex || '#2a78d6').replace('#', '');
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function statusFor(pct) {
  if (pct > 100) return 'critical';
  if (pct >= 80) return 'warning';
  return 'good';
}
function statusLabel(status) {
  return status === 'critical' ? '⛔ Over budget' : status === 'warning' ? '⚠️ Near limit' : '✅ On track';
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- data loading ----------

async function loadProfiles() {
  const { data, error } = await sb.from('profiles').select('*').order('sort_order', { ascending: true });
  if (error) { toast('Error loading profiles: ' + error.message); throw error; }
  profiles = data || [];
}

async function loadMonthData() {
  const monthStartISO = fmtDateISO(currentMonth);
  const monthEndISO = fmtDateISO(addMonths(currentMonth, 1));

  const [expRes, budRes] = await Promise.all([
    sb.from('expenses').select('*').gte('expense_date', monthStartISO).lt('expense_date', monthEndISO).order('expense_date', { ascending: false }),
    sb.from('budgets').select('*').eq('month', monthStartISO),
  ]);

  if (expRes.error) { toast('Error loading expenses: ' + expRes.error.message); throw expRes.error; }
  if (budRes.error) { toast('Error loading budgets: ' + budRes.error.message); throw budRes.error; }

  expenses = expRes.data || [];
  budgets = budRes.data || [];
}

function computeProfileStats(profileId) {
  const budgetRow = budgets.find(b => b.profile_id === profileId);
  const budgetAmt = budgetRow ? Number(budgetRow.amount) : 0;
  const spent = expenses.filter(e => e.profile_id === profileId).reduce((s, e) => s + Number(e.amount), 0);
  const remaining = budgetAmt - spent;
  const pct = budgetAmt > 0 ? (spent / budgetAmt) * 100 : (spent > 0 ? 101 : 0);
  return { budgetAmt, spent, remaining, pct, status: statusFor(pct) };
}

function filteredExpenses() {
  if (activeProfileFilter === 'all') return expenses;
  return expenses.filter(e => e.profile_id === activeProfileFilter);
}

// ---------- rendering ----------

function renderMonthLabel() {
  document.getElementById('monthLabel').textContent = currentMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

function renderStats() {
  let totalBudget = 0, totalSpent = 0;
  profiles.forEach(p => {
    const s = computeProfileStats(p.id);
    totalBudget += s.budgetAmt;
    totalSpent += s.spent;
  });
  const remaining = totalBudget - totalSpent;
  const pct = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : (totalSpent > 0 ? 101 : 0);
  const status = statusFor(pct);

  document.getElementById('statBudget').textContent = fmtMoney(totalBudget);
  document.getElementById('statSpent').textContent = fmtMoney(totalSpent);

  const remainEl = document.getElementById('statRemaining');
  const remainLabel = document.getElementById('statRemainingLabel');
  if (remaining < 0) {
    remainLabel.textContent = 'Over budget by';
    remainEl.textContent = fmtMoney(Math.abs(remaining));
    remainEl.classList.add('critical');
  } else {
    remainLabel.textContent = 'Remaining';
    remainEl.textContent = fmtMoney(remaining);
    remainEl.classList.remove('critical');
  }

  const fill = document.getElementById('overallFill');
  fill.style.width = Math.min(pct, 100) + '%';
  fill.className = 'progress-fill ' + status;

  const statusText = document.getElementById('overallStatusText');
  statusText.textContent = `${statusLabel(status)} · ${Math.min(pct, 100).toFixed(0)}%`;
  statusText.className = 'status-text ' + status;
}

function renderProfiles() {
  const grid = document.getElementById('profileGrid');
  grid.innerHTML = '';

  profiles.forEach(p => {
    const s = computeProfileStats(p.id);
    const card = document.createElement('div');
    card.className = 'profile-card' + (activeProfileFilter === p.id ? ' selected' : '');
    card.style.setProperty('--accent', p.color);

    card.innerHTML = `
      <div class="profile-head">
        <div class="profile-emoji" style="background:${hexToRgba(p.color, 0.15)}">${p.emoji}</div>
        <div class="profile-name-wrap">
          <div class="profile-name">
            <span class="name-text">${escapeHtml(p.name)}</span>
            <button class="rename-btn" data-action="rename" title="Rename">✏️</button>
          </div>
        </div>
      </div>
      <div class="profile-numbers">
        <span>Budget: <span class="budget-value" data-action="edit-budget">${s.budgetAmt > 0 ? fmtMoney(s.budgetAmt) : 'set budget'}</span></span>
        <span class="spent">Spent: ${fmtMoney(s.spent)}</span>
      </div>
      <div class="progress-track"><div class="progress-fill ${s.status}" style="width:${Math.min(s.pct, 100)}%"></div></div>
      <div class="profile-status-line">
        <span class="status-text ${s.status}">${statusLabel(s.status)}</span>
        <span class="remaining">${s.remaining < 0 ? 'over by ' + fmtMoney(Math.abs(s.remaining)) : fmtMoney(s.remaining) + ' left'}</span>
      </div>
    `;

    // rename
    card.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(card, p);
    });

    // budget edit
    card.querySelector('[data-action="edit-budget"]').addEventListener('click', (e) => {
      e.stopPropagation();
      startBudgetEdit(card, p, s.budgetAmt);
    });

    // click card body -> filter transactions to this profile
    card.addEventListener('click', () => {
      activeProfileFilter = p.id;
      renderTabs();
      renderTransactions();
      renderCategoryChart();
      renderProfiles();
    });

    grid.appendChild(card);
  });
}

function startRename(card, profile) {
  const nameSpan = card.querySelector('.name-text');
  const wrap = card.querySelector('.profile-name');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = profile.name;
  wrap.innerHTML = '';
  wrap.appendChild(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim() || profile.name;
    if (newName !== profile.name) {
      const { error } = await sb.from('profiles').update({ name: newName }).eq('id', profile.id);
      if (error) { toast('Rename failed: ' + error.message); }
      else { profile.name = newName; toast('Profile renamed'); }
    }
    renderProfiles();
    renderTabs();
    renderModalProfilePicker();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = profile.name; input.blur(); }
  });
}

function startBudgetEdit(card, profile, currentAmt) {
  const valSpan = card.querySelector('.budget-value');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '0.01';
  input.value = currentAmt > 0 ? currentAmt : '';
  input.placeholder = '0.00';
  const parent = valSpan.parentElement;
  parent.replaceChild(input, valSpan);
  input.focus();
  input.select();

  const commit = async () => {
    const amt = parseFloat(input.value);
    if (!isNaN(amt) && amt >= 0) {
      const monthISO = fmtDateISO(currentMonth);
      const { error } = await sb.from('budgets').upsert(
        { profile_id: profile.id, month: monthISO, amount: amt },
        { onConflict: 'profile_id,month' }
      );
      if (error) { toast('Budget update failed: ' + error.message); }
      else {
        toast('Budget updated');
        await loadMonthData();
        renderAll();
        return;
      }
    }
    renderProfiles();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') renderProfiles();
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderCategoryChart() {
  const heading = document.getElementById('chartHeading');
  const container = document.getElementById('categoryChart');
  const data = filteredExpenses();

  const profileLabel = activeProfileFilter === 'all' ? 'All profiles' : (profiles.find(p => p.id === activeProfileFilter)?.name || 'Profile');
  heading.textContent = `${profileLabel} — this month`;

  if (data.length === 0) {
    container.innerHTML = '<div class="empty-note">No expenses yet this month.</div>';
    return;
  }

  const totals = {};
  data.forEach(e => { totals[e.category] = (totals[e.category] || 0) + Number(e.amount); });
  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((s, r) => s + r[1], 0);
  const max = rows[0][1];

  if (chartTableView) {
    let html = '<table class="data-table"><thead><tr><th>Category</th><th class="num">Amount</th><th class="num">% of total</th></tr></thead><tbody>';
    rows.forEach(([cat, amt]) => {
      html += `<tr><td>${escapeHtml(cat)}</td><td class="num">${fmtMoney(amt)}</td><td class="num">${((amt / total) * 100).toFixed(0)}%</td></tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  } else {
    let html = '';
    rows.forEach(([cat, amt]) => {
      const pctOfMax = (amt / max) * 100;
      const pctOfTotal = ((amt / total) * 100).toFixed(0);
      html += `
        <div class="bar-row">
          <span class="cat-label">${escapeHtml(cat)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pctOfMax}%"></div></div>
          <span class="cat-value">${fmtMoney(amt)}</span>
          <span class="bar-tooltip">${escapeHtml(cat)}: ${fmtMoney(amt)} (${pctOfTotal}% of total)</span>
        </div>`;
    });
    container.innerHTML = html;
  }
}

function renderTabs() {
  const tabs = document.getElementById('profileTabs');
  tabs.innerHTML = '';

  const allTab = document.createElement('button');
  allTab.className = 'tab' + (activeProfileFilter === 'all' ? ' active' : '');
  allTab.textContent = 'All';
  allTab.addEventListener('click', () => {
    activeProfileFilter = 'all';
    renderTabs(); renderTransactions(); renderCategoryChart(); renderProfiles();
  });
  tabs.appendChild(allTab);

  profiles.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (activeProfileFilter === p.id ? ' active' : '');
    btn.textContent = `${p.emoji} ${p.name}`;
    btn.addEventListener('click', () => {
      activeProfileFilter = p.id;
      renderTabs(); renderTransactions(); renderCategoryChart(); renderProfiles();
    });
    tabs.appendChild(btn);
  });
}

function renderTransactions() {
  const list = document.getElementById('txnList');
  const data = filteredExpenses();

  if (data.length === 0) {
    list.innerHTML = '<div class="empty-note">No transactions for this filter.</div>';
    return;
  }

  list.innerHTML = '';
  data.forEach(e => {
    const profile = profiles.find(p => p.id === e.profile_id);
    const row = document.createElement('div');
    row.className = 'txn-row';
    const dateStr = new Date(e.expense_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    row.innerHTML = `
      <div class="txn-avatar" style="background:${hexToRgba(profile?.color, 0.18)}">${profile?.emoji || '👤'}</div>
      <div class="txn-main">
        <div class="txn-cat">${escapeHtml(e.category)}</div>
        <div class="txn-meta">${escapeHtml(profile?.name || '')} · ${dateStr}${e.note ? ' · ' + escapeHtml(e.note) : ''}</div>
      </div>
      <div class="txn-amount">${fmtMoney(e.amount)}</div>
      <button class="txn-del" title="Delete">🗑️</button>
    `;
    row.querySelector('.txn-del').addEventListener('click', () => deleteExpense(e.id));
    list.appendChild(row);
  });
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;
  const { error } = await sb.from('expenses').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message); return; }
  await loadMonthData();
  renderAll();
  toast('Expense deleted');
}

function renderAll() {
  renderMonthLabel();
  renderStats();
  renderProfiles();
  renderCategoryChart();
  renderTabs();
  renderTransactions();
}

// ---------- excel import / export ----------

const EXCEL_HEADERS = ['Date', 'Profile', 'Category', 'Amount', 'Note'];
let pendingImportRows = [];

function exportToExcel() {
  const data = filteredExpenses();
  if (data.length === 0) { toast('Nothing to export for this view'); return; }

  const rows = data.map(e => {
    const profile = profiles.find(p => p.id === e.profile_id);
    return {
      Date: e.expense_date,
      Profile: profile?.name || '',
      Category: e.category,
      Amount: Number(e.amount),
      Note: e.note || '',
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows, { header: EXCEL_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Expenses');

  const profileLabel = (activeProfileFilter === 'all' ? 'All' : (profiles.find(p => p.id === activeProfileFilter)?.name || 'Profile')).replace(/\s+/g, '_');
  const monthLabel = currentMonth.toLocaleString(undefined, { month: 'short', year: 'numeric' }).replace(/\s+/g, '_');
  XLSX.writeFile(wb, `expenses_${profileLabel}_${monthLabel}.xlsx`);
  toast(`Exported ${rows.length} row(s)`);
}

function downloadTemplate() {
  const sample = [{ Date: fmtDateISO(new Date()), Profile: profiles[0]?.name || 'Profile 1', Category: 'Food', Amount: 12.5, Note: 'example row - delete me' }];
  const ws = XLSX.utils.json_to_sheet(sample, { header: EXCEL_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Expenses');
  XLSX.writeFile(wb, 'expense_import_template.xlsx');
}

function excelDateToISO(val) {
  if (val instanceof Date && !isNaN(val.getTime())) return fmtDateISO(val);
  const s = String(val ?? '').trim();
  if (!s) return null;
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : fmtDateISO(parsed);
}

async function handleImportFile(file) {
  let wb;
  try {
    const buf = await file.arrayBuffer();
    wb = XLSX.read(buf, { type: 'array', cellDates: true });
  } catch (err) {
    toast('Could not read file: ' + err.message);
    return;
  }

  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defaultValue: '' });

  const valid = [];
  let skipped = 0;
  const skipReasons = [];

  rows.forEach((row, idx) => {
    const profileName = String(row.Profile || '').trim();
    const profile = profiles.find(p => p.name.toLowerCase() === profileName.toLowerCase());
    const amount = parseFloat(row.Amount);
    const dateISO = excelDateToISO(row.Date);
    const category = String(row.Category || '').trim() || 'Other';
    const note = String(row.Note || '').trim();

    if (!profile || isNaN(amount) || amount <= 0 || !dateISO) {
      skipped++;
      const reason = !profile ? `unknown profile "${profileName}"` : (isNaN(amount) || amount <= 0) ? 'invalid amount' : 'invalid date';
      skipReasons.push(`Row ${idx + 2}: ${reason}`);
      return;
    }
    valid.push({
      profile_id: profile.id, amount, category, note: note || null, expense_date: dateISO,
      _preview: { profileName: profile.name, amount, category, dateISO, note },
    });
  });

  pendingImportRows = valid;
  showImportSummary(rows.length, valid, skipped, skipReasons);
}

function showImportSummary(total, valid, skipped, skipReasons) {
  const summary = document.getElementById('importSummary');
  const previewWrap = document.getElementById('importPreviewWrap');
  summary.innerHTML = `Found <strong>${total}</strong> row(s): <strong>${valid.length}</strong> ready to import, <strong>${skipped}</strong> skipped.`;

  let html = '';
  if (valid.length > 0) {
    html += '<table class="data-table"><thead><tr><th>Date</th><th>Profile</th><th>Category</th><th class="num">Amount</th><th>Note</th></tr></thead><tbody>';
    valid.slice(0, 20).forEach(r => {
      html += `<tr><td>${r._preview.dateISO}</td><td>${escapeHtml(r._preview.profileName)}</td><td>${escapeHtml(r._preview.category)}</td><td class="num">${fmtMoney(r._preview.amount)}</td><td>${escapeHtml(r._preview.note)}</td></tr>`;
    });
    if (valid.length > 20) html += `<tr><td colspan="5" class="empty-note">…and ${valid.length - 20} more</td></tr>`;
    html += '</tbody></table>';
  } else {
    html += '<div class="empty-note">No valid rows to import.</div>';
  }
  if (skipped > 0) {
    html += `<div class="empty-note">${skipReasons.slice(0, 10).map(escapeHtml).join('<br>')}${skipReasons.length > 10 ? '<br>…' : ''}</div>`;
  }
  previewWrap.innerHTML = html;

  document.getElementById('importConfirm').disabled = valid.length === 0;
  document.getElementById('importOverlay').classList.add('open');
}

async function confirmImport() {
  if (pendingImportRows.length === 0) return;
  const inserts = pendingImportRows.map(({ _preview, ...rest }) => rest);
  const { error } = await sb.from('expenses').insert(inserts);
  document.getElementById('importOverlay').classList.remove('open');
  if (error) { toast('Import failed: ' + error.message); return; }
  toast(`Imported ${inserts.length} expense(s)`);
  pendingImportRows = [];
  await loadMonthData();
  renderAll();
}

// ---------- modal ----------

function renderModalProfilePicker() {
  const picker = document.getElementById('modalProfilePicker');
  picker.innerHTML = '';
  profiles.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'profile-pick-btn' + (selectedModalProfile === p.id ? ' selected' : '');
    btn.style.setProperty('--accent', p.color);
    btn.innerHTML = `<span class="emo">${p.emoji}</span><span>${escapeHtml(p.name)}</span>`;
    btn.addEventListener('click', () => {
      selectedModalProfile = p.id;
      renderModalProfilePicker();
    });
    picker.appendChild(btn);
  });
}

function openModal() {
  selectedModalProfile = activeProfileFilter !== 'all' ? activeProfileFilter : (profiles[0]?.id || null);
  renderModalProfilePicker();
  document.getElementById('fAmount').value = '';
  document.getElementById('fNote').value = '';
  document.getElementById('fDate').value = fmtDateISO(new Date());
  document.getElementById('fCategory').value = CATEGORIES[0];
  document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

async function saveExpense() {
  const amount = parseFloat(document.getElementById('fAmount').value);
  const category = document.getElementById('fCategory').value;
  const dateVal = document.getElementById('fDate').value;
  const note = document.getElementById('fNote').value.trim();

  if (!selectedModalProfile) { toast('Pick a profile'); return; }
  if (isNaN(amount) || amount <= 0) { toast('Enter a valid amount'); return; }
  if (!dateVal) { toast('Pick a date'); return; }

  const { error } = await sb.from('expenses').insert({
    profile_id: selectedModalProfile,
    amount,
    category,
    note: note || null,
    expense_date: dateVal,
  });

  if (error) { toast('Save failed: ' + error.message); return; }

  closeModal();
  toast('Expense added');

  const expenseMonth = startOfMonth(new Date(dateVal + 'T00:00:00'));
  if (expenseMonth.getTime() !== currentMonth.getTime()) {
    currentMonth = expenseMonth;
  }
  await loadMonthData();
  renderAll();
}

// ---------- theme ----------

function applyStoredTheme() {
  const stored = localStorage.getItem('theme');
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.setAttribute('data-theme', stored);
  }
  updateThemeIcon();
}

function updateThemeIcon() {
  const explicit = document.documentElement.getAttribute('data-theme');
  const effectiveDark = explicit ? explicit === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.getElementById('themeToggle').textContent = effectiveDark ? '☀️' : '🌙';
}

function toggleTheme() {
  const explicit = document.documentElement.getAttribute('data-theme');
  const effectiveDark = explicit ? explicit === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = effectiveDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon();
}

// ---------- init ----------

async function init() {
  applyStoredTheme();
  await setupLock();

  CATEGORIES.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    document.getElementById('fCategory').appendChild(opt);
  });

  document.getElementById('prevMonth').addEventListener('click', async () => {
    currentMonth = addMonths(currentMonth, -1);
    await loadMonthData();
    renderAll();
  });
  document.getElementById('nextMonth').addEventListener('click', async () => {
    currentMonth = addMonths(currentMonth, 1);
    await loadMonthData();
    renderAll();
  });
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('fabAdd').addEventListener('click', openModal);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('modalSave').addEventListener('click', saveExpense);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
  document.getElementById('toggleTableView').addEventListener('click', () => {
    chartTableView = !chartTableView;
    document.getElementById('toggleTableView').textContent = chartTableView ? 'View as chart' : 'View as table';
    renderCategoryChart();
  });

  document.getElementById('exportBtn').addEventListener('click', exportToExcel);
  document.getElementById('downloadTemplateBtn').addEventListener('click', downloadTemplate);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImportFile(file);
    e.target.value = '';
  });
  document.getElementById('importCancel').addEventListener('click', () => document.getElementById('importOverlay').classList.remove('open'));
  document.getElementById('importConfirm').addEventListener('click', confirmImport);
  document.getElementById('importOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'importOverlay') document.getElementById('importOverlay').classList.remove('open');
  });

  try {
    await loadProfiles();
  } catch {
    document.querySelector('.app').innerHTML = `
      <div class="empty-note" style="padding:60px 20px; text-align:center;">
        Could not load profiles. Make sure you've run <code>schema.sql</code> in the
        Supabase SQL editor for this project, then reload this page.
      </div>`;
    return;
  }

  if (profiles.length === 0) {
    document.querySelector('.app').innerHTML = `
      <div class="empty-note" style="padding:60px 20px; text-align:center;">
        No profiles found yet. Run <code>schema.sql</code> in the Supabase SQL editor
        to seed the 4 profiles, then reload this page.
      </div>`;
    return;
  }

  await loadMonthData();
  renderAll();
}

init();
