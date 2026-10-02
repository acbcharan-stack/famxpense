import * as XLSX from 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm';
import {
  sb, setupAuth, toast, fmtMoney, hexToRgba, escapeHtml,
  pad, fmtDateISO, startOfMonth, addMonths,
  applyStoredTheme, toggleTheme, initSidebar,
  INVESTMENT_CATEGORY, sumInvested, totalProjected, PROJECTION_MILESTONES,
  tradesSummary, goalProgress,
  savingsMonthlyBudgetImpact, investmentsMonthlyBudgetImpact,
  CATEGORIES, fileToScaledJpeg, scanReceipts,
} from './common.js';

const MAX_SCAN_IMAGES = 5;

let profiles = [];
let currentMonth = startOfMonth(new Date());
let expenses = [];
let budgets = [];
let investments = [];
let trades = [];
let savings = [];
let savingsTableReady = true;
let bankBalances = [];
let bankTableReady = true;
let withdrawals = [];
let activeProfileFilter = 'all';
let selectedModalProfile = null;
let chartTableView = false;
let goalModalProfile = null;
let scanDraft = [];

const TREND_MONTHS = 6;
let trendExpenses = [];

// ---------- helpers ----------

function statusFor(pct) {
  if (pct > 100) return 'critical';
  if (pct >= 80) return 'warning';
  return 'good';
}
function statusLabel(status) {
  return status === 'critical' ? '⛔ Over budget' : status === 'warning' ? '⚠️ Near limit' : '✅ On track';
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

async function loadTrendData() {
  const rangeStartISO = fmtDateISO(addMonths(currentMonth, -(TREND_MONTHS - 1)));
  const rangeEndISO = fmtDateISO(addMonths(currentMonth, 1));

  const { data, error } = await sb.from('expenses')
    .select('profile_id, amount, expense_date')
    .gte('expense_date', rangeStartISO)
    .lt('expense_date', rangeEndISO);

  if (error) { toast('Error loading trend: ' + error.message); throw error; }
  trendExpenses = data || [];
}

async function loadInvestments() {
  const { data, error } = await sb.from('investments').select('*');
  if (error) { toast('Error loading investments: ' + error.message); throw error; }
  investments = data || [];
}

async function loadTrades() {
  const { data, error } = await sb.from('trades').select('*');
  if (error) { toast('Error loading trades: ' + error.message); throw error; }
  trades = data || [];
}

// Non-fatal: if the savings table hasn't been migrated in yet, budgets just fall back to
// tracking expenses only (see schema.sql).
async function loadSavings() {
  const { data, error } = await sb.from('savings').select('*');
  if (error) { savingsTableReady = false; savings = []; return; }
  savingsTableReady = true;
  savings = data || [];
}

// Non-fatal: if the bank_balances table hasn't been created yet the rest of the page still works.
async function loadBankBalance() {
  const { data, error } = await sb.from('bank_balances').select('*').eq('month', fmtDateISO(currentMonth));
  if (error) { bankTableReady = false; bankBalances = []; return; }
  bankTableReady = true;
  bankBalances = data || [];
}

// Non-fatal: spending out of savings only matters for the bank balance memo.
async function loadWithdrawals() {
  const { data, error } = await sb.from('savings_withdrawals').select('*')
    .gte('withdrawn_date', fmtDateISO(currentMonth)).lt('withdrawn_date', fmtDateISO(addMonths(currentMonth, 1)));
  withdrawals = error ? [] : (data || []);
}

async function loadAllData() {
  await Promise.all([loadMonthData(), loadTrendData(), loadInvestments(), loadTrades(), loadSavings(), loadBankBalance(), loadWithdrawals()]);
}

function computeProfileStats(profileId) {
  const budgetRow = budgets.find(b => b.profile_id === profileId);
  const budgetAmt = budgetRow ? Number(budgetRow.amount) : 0;
  const spentExpenses = expenses.filter(e => e.profile_id === profileId).reduce((s, e) => s + Number(e.amount), 0);
  // "Spent" is only the expenses added — savings and investments are tracked on their own pages.
  const spent = spentExpenses;
  const remaining = budgetAmt - spent;
  const pct = budgetAmt > 0 ? (spent / budgetAmt) * 100 : (spent > 0 ? 101 : 0);
  return { budgetAmt, spent, spentExpenses, remaining, pct, status: statusFor(pct) };
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

// What left the bank account this month for a profile: expenses, plus investments and savings
// whose "count against the monthly budget" box is ticked.
function bankOutflow(profileId) {
  const expensesOut = expenses.filter(e => e.profile_id === profileId).reduce((s, e) => s + Number(e.amount), 0);
  const investOut = investmentsMonthlyBudgetImpact(investments.filter(i => i.profile_id === profileId), currentMonth);
  const savingsOut = savingsMonthlyBudgetImpact(savings.filter(s => s.profile_id === profileId), currentMonth);
  // Savings spent this month (saved earlier): leaves the bank but isn't a budget item.
  const withdrawnOut = withdrawals.filter(w => w.profile_id === profileId).reduce((s, w) => s + Number(w.amount), 0);
  return { expensesOut, investOut, savingsOut, withdrawnOut, total: expensesOut + investOut + savingsOut + withdrawnOut };
}

// Fills the "expected end balance" field and the short/high memo from the card's current inputs.
function updateBankCard(card, profileId) {
  const num = sel => {
    const raw = card.querySelector(sel).value;
    return raw === '' ? null : parseFloat(raw);
  };
  const opening = num('.bank-opening');
  const closing = num('.bank-closing');
  const expectedEl = card.querySelector('.bank-expected');
  const hint = card.querySelector('.bank-hint');
  const memo = card.querySelector('.bank-memo');
  const out = bankOutflow(profileId);

  hint.textContent = !bankTableReady
    ? 'Run the bank_balances block at the end of schema.sql in Supabase, then reload.'
    : `Deducted: ${fmtMoney(out.expensesOut)} expenses + ${fmtMoney(out.investOut)} investments + ${fmtMoney(out.savingsOut)} savings${out.withdrawnOut > 0 ? ` + ${fmtMoney(out.withdrawnOut)} spent from savings` : ''}`;
  memo.className = 'bank-memo';
  memo.textContent = '';

  if (opening == null || isNaN(opening)) {
    expectedEl.value = '';
    expectedEl.placeholder = 'Enter start amount';
    return;
  }
  const expected = opening - out.total;
  expectedEl.value = expected.toFixed(2);

  if (closing == null || isNaN(closing)) return;
  const diff = closing - expected;
  if (Math.abs(diff) < 0.5) {
    memo.textContent = '✅ Matches — every rupee is accounted for.';
    memo.classList.add('good');
  } else if (diff < 0) {
    memo.textContent = `⚠️ Short by ${fmtMoney(Math.abs(diff))} — probably an expense that wasn't recorded.`;
    memo.classList.add('critical');
  } else {
    memo.textContent = `⚠️ High by ${fmtMoney(diff)} — maybe income received, or an expense recorded that wasn't paid from this account.`;
    memo.classList.add('warning');
  }
}

// Per-profile start/end-of-month bank balance — a reference record only, never part of budgets.
function bankSectionHtml(profileId) {
  const row = bankBalances.find(b => b.profile_id === profileId);
  const dis = bankTableReady ? '' : 'disabled';
  return `
    <div class="bank-section">
      <div class="bank-title">🏦 Bank balance <span class="bank-sub">for your records</span></div>
      <div class="bank-card">
        <div class="bank-field">
          <label>Start of month</label>
          <input type="number" step="0.01" class="bank-opening" placeholder="Amount" value="${row?.opening_balance ?? ''}" ${dis} />
        </div>
        <div class="bank-field">
          <label>Expected end (after spending)</label>
          <input type="number" class="bank-expected" readonly tabindex="-1" />
        </div>
        <div class="bank-field">
          <label>Actual end of month</label>
          <input type="number" step="0.01" class="bank-closing" placeholder="Amount in bank" value="${row?.closing_balance ?? ''}" ${dis} />
        </div>
        <button class="btn btn-primary btn-sm bank-save" ${dis}>Save</button>
        <div class="bank-memo"></div>
        <div class="field-hint bank-hint"></div>
      </div>
    </div>`;
}

async function saveBankBalance(profile, card) {
  const parse = sel => {
    const raw = card.querySelector(sel).value;
    return raw === '' ? null : parseFloat(raw);
  };
  const opening = parse('.bank-opening');
  const closing = parse('.bank-closing');
  if ((opening != null && isNaN(opening)) || (closing != null && isNaN(closing))) {
    toast('Enter valid amounts');
    return;
  }
  const { error } = await sb.from('bank_balances').upsert(
    { profile_id: profile.id, month: fmtDateISO(currentMonth), opening_balance: opening, closing_balance: closing },
    { onConflict: 'profile_id,month' }
  );
  if (error) { toast('Save failed: ' + error.message); return; }
  toast(`${profile.name}'s bank balance saved`);
  await loadBankBalance();
  renderProfiles();
}

function renderProfiles() {
  const grid = document.getElementById('profileGrid');
  grid.innerHTML = '';

  profiles.forEach(p => {
    const s = computeProfileStats(p.id);
    const card = document.createElement('div');
    card.className = 'profile-card' + (activeProfileFilter === p.id ? ' selected' : '');
    card.style.setProperty('--accent', p.color);

    const showLeftoverBtn = s.remaining > 0.004 && !hasLeftoverSaved(p.id);

    card.innerHTML = `
      <div class="profile-head">
        <div class="profile-emoji" style="background:${hexToRgba(p.color, 0.15)}">${p.emoji}</div>
        <div class="profile-name-wrap">
          <div class="profile-name">
            <span class="name-text">${escapeHtml(p.name)}</span>
            <button class="rename-btn" data-action="rename" title="Rename">✏️</button>
            <button class="rename-btn" data-action="details" title="View profile details">📊</button>
          </div>
        </div>
      </div>
      <div class="profile-numbers">
        <span>Budget: <span class="budget-value" data-action="edit-budget">${s.budgetAmt > 0 ? fmtMoney(s.budgetAmt) : 'set budget'}</span><button class="budget-adjust-btn" data-action="adjust-budget" title="Add or reduce budget">±</button></span>
        <span class="spent">Spent: ${fmtMoney(s.spent)}</span>
      </div>
      <div class="progress-track"><div class="progress-fill ${s.status}" style="width:${Math.min(s.pct, 100)}%"></div></div>
      <div class="profile-status-line">
        <span class="status-text ${s.status}">${statusLabel(s.status)}</span>
        <span class="remaining">${s.remaining < 0 ? 'over by ' + fmtMoney(Math.abs(s.remaining)) : fmtMoney(s.remaining) + ' left'}</span>
      </div>
      ${showLeftoverBtn ? `<button class="link-btn leftover-btn" data-action="save-leftover">🐷 Move ${fmtMoney(s.remaining)} leftover to savings</button>` : ''}
      ${bankSectionHtml(p.id)}
    `;

    // bank balance: keep clicks inside from selecting the profile filter
    const bankSection = card.querySelector('.bank-section');
    bankSection.addEventListener('click', (e) => e.stopPropagation());
    card.querySelector('.bank-save').addEventListener('click', () => saveBankBalance(p, card));
    card.querySelectorAll('.bank-opening, .bank-closing').forEach(el =>
      el.addEventListener('input', () => updateBankCard(card, p.id)));
    updateBankCard(card, p.id);

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

    // budget top-up / reduce
    card.querySelector('[data-action="adjust-budget"]').addEventListener('click', (e) => {
      e.stopPropagation();
      startBudgetAdjust(card, p, s.budgetAmt);
    });

    // move leftover budget to savings
    card.querySelector('[data-action="save-leftover"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      saveLeftoverToSavings(p, s.remaining);
    });

    // profile detail view
    card.querySelector('[data-action="details"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openProfileDetail(p);
    });

    // click card body -> filter transactions to this profile
    card.addEventListener('click', () => {
      activeProfileFilter = p.id;
      renderTabs();
      renderTransactions();
      renderCategoryChart();
      renderTrendChart();
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

// Add (or, with a negative number, take away) an amount from the existing budget instead of
// retyping the whole total — for when extra money shows up mid-month, or plans change.
function startBudgetAdjust(card, profile, currentAmt) {
  const btn = card.querySelector('[data-action="adjust-budget"]');
  const wrap = document.createElement('span');
  wrap.className = 'budget-edit budget-adjust-wrap';
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.01';
  input.placeholder = '+500 or -200';
  wrap.appendChild(input);
  btn.replaceWith(wrap);
  input.focus();

  const commit = async () => {
    const delta = parseFloat(input.value);
    if (!isNaN(delta) && delta !== 0) {
      const newAmt = Math.max(0, currentAmt + delta);
      const monthISO = fmtDateISO(currentMonth);
      const { error } = await sb.from('budgets').upsert(
        { profile_id: profile.id, month: monthISO, amount: newAmt },
        { onConflict: 'profile_id,month' }
      );
      if (error) { toast('Budget update failed: ' + error.message); }
      else {
        toast(delta > 0 ? `Added ${fmtMoney(delta)} to budget` : `Reduced budget by ${fmtMoney(Math.abs(delta))}`);
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

// One-click way to bank whatever's left of a profile's budget into Savings, tagged so it never
// gets offered twice for the same profile+month and never double-counts as new budget spend.
function leftoverSavingsName(monthISO) { return `Leftover budget — ${monthISO}`; }

function hasLeftoverSaved(profileId) {
  const name = leftoverSavingsName(fmtDateISO(currentMonth));
  return savings.some(s => s.profile_id === profileId && s.name === name);
}

async function saveLeftoverToSavings(profile, remaining) {
  if (remaining <= 0) return;
  if (!savingsTableReady) { toast('Run the updated schema.sql to enable savings first'); return; }
  const monthISO = fmtDateISO(currentMonth);
  const monthLabel = currentMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  if (!confirm(`Move ${fmtMoney(remaining)} of ${profile.name}'s unspent ${monthLabel} budget into Savings?`)) return;

  const lastDay = fmtDateISO(new Date(addMonths(currentMonth, 1).getTime() - 86400000));
  const { error } = await sb.from('savings').insert({
    profile_id: profile.id,
    name: leftoverSavingsName(monthISO),
    amount: remaining,
    saved_date: lastDay,
    note: `Unspent budget for ${monthLabel}`,
    count_in_budget: false,
  });
  if (error) { toast('Failed: ' + error.message); return; }

  toast('Leftover moved to savings');
  await loadSavings();
  renderAll();
}

function renderCategoryChart() {
  const heading = document.getElementById('chartHeading');
  const container = document.getElementById('categoryChart');
  const data = filteredExpenses();

  const profileLabel = activeProfileFilter === 'all' ? 'All profiles' : (profiles.find(p => p.id === activeProfileFilter)?.name || 'Profile');
  heading.textContent = `${profileLabel} — this month`;

  const totals = {};
  data.forEach(e => { totals[e.category] = (totals[e.category] || 0) + Number(e.amount); });

  // "Savings & Investment" reflects real invested principal (from the Investments page), not
  // just this month's logged expenses under that category — only shown in the "all profiles" view
  // since investments aren't tied to a profile.
  const investedTotal = sumInvested(investments);
  if (investedTotal > 0 && activeProfileFilter === 'all') totals[INVESTMENT_CATEGORY] = investedTotal;

  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  if (rows.length === 0) {
    container.innerHTML = '<div class="empty-note">No expenses yet this month.</div>';
    return;
  }

  const total = rows.reduce((s, r) => s + r[1], 0);
  const max = rows[0][1];

  if (chartTableView) {
    let html = '<table class="data-table"><thead><tr><th>Category</th><th class="num">Amount</th><th class="num">% of total</th></tr></thead><tbody>';
    rows.forEach(([cat, amt]) => {
      const isInvestment = cat === INVESTMENT_CATEGORY;
      html += `<tr class="${isInvestment ? 'investment-row' : ''}"><td>${escapeHtml(cat)}${isInvestment ? ' <span class="cat-badge">↗ Investments</span>' : ''}</td><td class="num">${fmtMoney(amt)}</td><td class="num">${((amt / total) * 100).toFixed(0)}%</td></tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  } else {
    let html = '';
    rows.forEach(([cat, amt]) => {
      const pctOfMax = (amt / max) * 100;
      const pctOfTotal = ((amt / total) * 100).toFixed(0);
      const isInvestment = cat === INVESTMENT_CATEGORY;
      html += `
        <div class="bar-row${isInvestment ? ' investment-row' : ''}">
          <span class="cat-label">${escapeHtml(cat)}${isInvestment ? ' <span class="cat-badge">↗</span>' : ''}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pctOfMax}%"></div></div>
          <span class="cat-value">${fmtMoney(amt)}</span>
          <span class="bar-tooltip">${escapeHtml(cat)}: ${fmtMoney(amt)}${isInvestment ? ' (total invested)' : ' (' + pctOfTotal + '% of total)'}</span>
        </div>`;
    });
    container.innerHTML = html;
  }

  container.querySelectorAll('.investment-row').forEach(el => {
    el.addEventListener('click', () => { window.location.href = 'investments.html'; });
  });
}

function monthKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }

function renderTrendChart() {
  const heading = document.getElementById('trendHeading');
  const container = document.getElementById('trendChart');

  const profileLabel = activeProfileFilter === 'all' ? 'All profiles' : (profiles.find(p => p.id === activeProfileFilter)?.name || 'Profile');
  heading.textContent = `${profileLabel} — last ${TREND_MONTHS} months`;

  const months = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i--) months.push(addMonths(currentMonth, -i));

  const scoped = activeProfileFilter === 'all' ? trendExpenses : trendExpenses.filter(e => e.profile_id === activeProfileFilter);

  const totals = months.map(m => {
    const key = monthKey(m);
    const total = scoped
      .filter(e => monthKey(new Date(e.expense_date + 'T00:00:00')) === key)
      .reduce((s, e) => s + Number(e.amount), 0);
    return { month: m, total };
  });

  if (totals.every(t => t.total === 0)) {
    container.innerHTML = '<div class="empty-note">No expense history yet.</div>';
    return;
  }

  const max = Math.max(...totals.map(t => t.total), 1);

  let html = '<div class="trend-bars">';
  totals.forEach(t => {
    const pct = Math.max((t.total / max) * 100, t.total > 0 ? 4 : 0);
    const isCurrent = t.month.getTime() === currentMonth.getTime();
    const label = t.month.toLocaleString(undefined, { month: 'short' });
    html += `
      <div class="trend-col${isCurrent ? ' current' : ''}">
        <span class="trend-value">${t.total > 0 ? fmtMoney(t.total) : ''}</span>
        <div class="trend-bar-track"><div class="trend-bar-fill" style="height:${pct}%"></div></div>
        <span class="trend-month">${label}</span>
      </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

function renderTabs() {
  const tabs = document.getElementById('profileTabs');
  tabs.innerHTML = '';

  const allTab = document.createElement('button');
  allTab.className = 'tab' + (activeProfileFilter === 'all' ? ' active' : '');
  allTab.textContent = 'All';
  allTab.addEventListener('click', () => {
    activeProfileFilter = 'all';
    renderTabs(); renderTransactions(); renderCategoryChart(); renderTrendChart(); renderProfiles();
  });
  tabs.appendChild(allTab);

  profiles.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (activeProfileFilter === p.id ? ' active' : '');
    btn.textContent = `${p.emoji} ${p.name}`;
    btn.addEventListener('click', () => {
      activeProfileFilter = p.id;
      renderTabs(); renderTransactions(); renderCategoryChart(); renderTrendChart(); renderProfiles();
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
  await loadAllData();
  renderAll();
  toast('Expense deleted');
}

function renderInvestmentDashboard() {
  const row = document.getElementById('investStatRow');
  const emptyNote = document.getElementById('investEmptyNote');
  if (!row) return;

  const totalInvested = sumInvested(investments);
  let html = `
    <div class="stat-tile">
      <div class="label">Total Invested</div>
      <div class="value">${fmtMoney(totalInvested)}</div>
    </div>`;
  PROJECTION_MILESTONES.forEach(y => {
    html += `
      <div class="stat-tile">
        <div class="label">In ${y} years</div>
        <div class="value">${fmtMoney(totalProjected(investments, y))}</div>
      </div>`;
  });
  row.innerHTML = html;

  emptyNote.style.display = investments.length === 0 ? 'block' : 'none';
  updateCustomProjection();
}

function updateCustomProjection() {
  const yearsInput = document.getElementById('investCustomYears');
  const valueEl = document.getElementById('investCustomValue');
  if (!yearsInput || !valueEl) return;
  const years = Math.max(1, parseInt(yearsInput.value, 10) || 1);
  valueEl.textContent = fmtMoney(totalProjected(investments, years));
}

function renderAll() {
  renderMonthLabel();
  renderStats();
  renderProfiles();
  renderCategoryChart();
  renderTrendChart();
  renderTabs();
  renderTransactions();
  renderInvestmentDashboard();
}

// ---------- profile detail & goals ----------

async function openProfileDetail(profile) {
  document.getElementById('profileDetailTitle').textContent = `${profile.emoji} ${profile.name}`;
  document.getElementById('profileDetailStats').innerHTML = '<div class="empty-note">Loading…</div>';
  document.getElementById('profileGoalSection').innerHTML = '';
  document.getElementById('profileDetailOverlay').classList.add('open');

  const monthStats = computeProfileStats(profile.id);

  const yearStart = new Date(currentMonth.getFullYear(), 0, 1);
  const yearEnd = new Date(currentMonth.getFullYear() + 1, 0, 1);
  const { data: yearExpenses, error: yearErr } = await sb.from('expenses')
    .select('amount')
    .eq('profile_id', profile.id)
    .gte('expense_date', fmtDateISO(yearStart))
    .lt('expense_date', fmtDateISO(yearEnd));
  const yearSpent = yearErr ? 0 : (yearExpenses || []).reduce((s, e) => s + Number(e.amount), 0);

  const totalInvested = sumInvested(investments.filter(i => i.profile_id === profile.id));
  const tradeStats = tradesSummary(trades.filter(t => t.profile_id === profile.id));

  document.getElementById('profileDetailStats').innerHTML = `
    <div class="stat-tile"><div class="label">This month spent</div><div class="value">${fmtMoney(monthStats.spent)}</div></div>
    <div class="stat-tile"><div class="label">This year spent</div><div class="value">${fmtMoney(yearSpent)}</div></div>
    <div class="stat-tile"><div class="label">Total invested</div><div class="value">${fmtMoney(totalInvested)}</div></div>
    <div class="stat-tile"><div class="label">Trading P&L (${tradeStats.closedCount} closed)</div><div class="value ${tradeStats.realizedGain < 0 ? 'critical' : ''}">${fmtMoney(tradeStats.realizedGain)}</div></div>
  `;

  await renderGoalSection(profile);
}

async function renderGoalSection(profile) {
  const section = document.getElementById('profileGoalSection');
  section.innerHTML = '<div class="empty-note">Loading…</div>';

  const { data: goalRows, error } = await sb.from('goals')
    .select('*')
    .eq('profile_id', profile.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) { section.innerHTML = '<div class="empty-note">Could not load goal.</div>'; return; }
  const goal = goalRows && goalRows[0];

  if (!goal) {
    section.innerHTML = `
      <div class="empty-note">No active savings goal yet.</div>
      <button type="button" class="btn btn-ghost btn-sm" id="setGoalBtn" style="margin-top:8px;">+ Set a goal</button>
    `;
    document.getElementById('setGoalBtn').addEventListener('click', () => openGoalModal(profile));
    return;
  }

  const goalStartMonth = startOfMonth(new Date(goal.created_at));
  const [budRes, expRes] = await Promise.all([
    sb.from('budgets').select('month, amount').eq('profile_id', profile.id).gte('month', fmtDateISO(goalStartMonth)),
    sb.from('expenses').select('amount, expense_date').eq('profile_id', profile.id).gte('expense_date', fmtDateISO(goalStartMonth)),
  ]);
  const progress = Math.max(0, goalProgress(goal.created_at, budRes.data || [], expRes.data || []));
  const pct = Math.min(100, (progress / Number(goal.target_amount)) * 100);
  const targetDateStr = goal.target_date
    ? new Date(goal.target_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  section.innerHTML = `
    <div class="investment-card" style="cursor:default; border-left-color: var(--status-good);">
      <div class="investment-head">
        <div class="investment-type">${escapeHtml(goal.name)}</div>
        <button class="txn-del" title="Abandon goal" id="abandonGoalBtn">🗑️</button>
      </div>
      <div class="investment-numbers">
        <span>Saved so far: <strong>${fmtMoney(progress)}</strong></span>
        <span>Target: <strong>${fmtMoney(goal.target_amount)}</strong></span>
      </div>
      <div class="progress-track" style="margin-top:8px;"><div class="progress-fill good" style="width:${pct}%"></div></div>
      <div class="investment-meta" style="margin-top:6px;">${pct.toFixed(0)}% of goal${targetDateStr ? ' · by ' + targetDateStr : ''} · auto-tracked from leftover monthly budget</div>
    </div>
  `;
  document.getElementById('abandonGoalBtn').addEventListener('click', async () => {
    if (!confirm('Abandon this goal?')) return;
    const { error: abandonErr } = await sb.from('goals').update({ status: 'abandoned' }).eq('id', goal.id);
    if (abandonErr) { toast('Failed: ' + abandonErr.message); return; }
    renderGoalSection(profile);
  });
}

function openGoalModal(profile) {
  goalModalProfile = profile;
  document.getElementById('gName').value = '';
  document.getElementById('gTarget').value = '';
  document.getElementById('gDate').value = '';
  document.getElementById('goalModalOverlay').classList.add('open');
}

function closeGoalModal() {
  document.getElementById('goalModalOverlay').classList.remove('open');
}

async function saveGoal() {
  const name = document.getElementById('gName').value.trim();
  const target = parseFloat(document.getElementById('gTarget').value);
  const targetDate = document.getElementById('gDate').value;

  if (!name) { toast('Enter a goal name'); return; }
  if (isNaN(target) || target <= 0) { toast('Enter a valid target amount'); return; }

  const { error } = await sb.from('goals').insert({
    profile_id: goalModalProfile.id,
    name,
    target_amount: target,
    target_date: targetDate || null,
    status: 'active',
  });
  if (error) { toast('Save failed: ' + error.message); return; }

  closeGoalModal();
  toast('Goal set');
  await renderGoalSection(goalModalProfile);
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
  await loadAllData();
  renderAll();
}

// ---------- receipt / screenshot scan ----------

function scanCategorySelect(value) {
  const sel = document.createElement('select');
  CATEGORIES.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    if (c === value) o.selected = true;
    sel.appendChild(o);
  });
  return sel;
}

function scanProfilePicker(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'profile-picker';
  profiles.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'profile-pick-btn' + (entry.profileId === p.id ? ' selected' : '');
    btn.style.setProperty('--accent', p.color);
    btn.innerHTML = `<span class="emo">${p.emoji}</span><span>${escapeHtml(p.name)}</span>`;
    btn.addEventListener('click', () => {
      entry.profileId = p.id;
      wrap.querySelectorAll('.profile-pick-btn').forEach((b, i) => {
        b.classList.toggle('selected', profiles[i].id === entry.profileId);
      });
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function scanInsertCount() {
  let n = 0;
  scanDraft.forEach(e => {
    if (!e.included) return;
    if (e.lineItems.length && e.splitMode) n += e.lineItems.filter(i => i.checked && i.amount > 0).length;
    else n += 1;
  });
  return n;
}

function updateScanSaveLabel() {
  const n = scanInsertCount();
  const btn = document.getElementById('scanSave');
  btn.textContent = n > 0 ? `Save ${n} expense${n === 1 ? '' : 's'}` : 'Save';
  btn.disabled = n === 0;
}

function buildScanCard(entry) {
  const card = document.createElement('div');
  card.className = 'scan-card';
  card.innerHTML = `
    <div class="scan-card-head">
      <input class="scan-merchant" type="text" placeholder="Merchant" />
      <button type="button" class="scan-remove" title="Exclude from save">✕</button>
    </div>
    <div class="scan-badges">
      <button type="button" class="scan-badge scan-dir ${entry.direction}"></button>
      ${entry.confidence != null ? `<span class="scan-badge muted">${Math.round(entry.confidence * 100)}% sure</span>` : ''}
    </div>
    <div class="scan-fields"></div>
  `;

  const merchantInput = card.querySelector('.scan-merchant');
  merchantInput.value = entry.merchant;
  merchantInput.addEventListener('input', () => { entry.merchant = merchantInput.value; });

  const dirBtn = card.querySelector('.scan-dir');
  const paintDir = () => {
    dirBtn.className = 'scan-badge scan-dir ' + entry.direction;
    dirBtn.textContent = entry.direction === 'credit' ? '↓ received' : '↑ spent';
  };
  paintDir();
  dirBtn.addEventListener('click', () => {
    entry.direction = entry.direction === 'credit' ? 'debit' : 'credit';
    paintDir();
  });

  card.querySelector('.scan-remove').addEventListener('click', () => {
    entry.included = false;
    card.remove();
    updateScanSaveLabel();
  });

  const fields = card.querySelector('.scan-fields');

  // amount + candidate chips
  const amountField = document.createElement('div');
  amountField.className = 'field';
  amountField.innerHTML = '<label>Amount charged</label>';
  const amountInput = document.createElement('input');
  amountInput.type = 'number'; amountInput.min = '0'; amountInput.step = '0.01';
  amountInput.value = entry.amount;
  amountInput.addEventListener('input', () => { entry.amount = amountInput.value; updateScanSaveLabel(); });
  amountField.appendChild(amountInput);
  if (entry.amountCandidates.length > 1) {
    const chips = document.createElement('div');
    chips.className = 'amount-chips';
    entry.amountCandidates.forEach(a => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'amount-chip';
      chip.textContent = fmtMoney(a);
      chip.addEventListener('click', () => {
        entry.amount = String(a);
        amountInput.value = a;
        updateScanSaveLabel();
      });
      chips.appendChild(chip);
    });
    amountField.appendChild(chips);
  }
  fields.appendChild(amountField);

  // date
  const dateField = document.createElement('div');
  dateField.className = 'field';
  dateField.innerHTML = '<label>Date</label>';
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.value = entry.date;
  dateInput.addEventListener('input', () => { entry.date = dateInput.value; });
  dateField.appendChild(dateInput);
  fields.appendChild(dateField);

  // profile
  const profField = document.createElement('div');
  profField.className = 'field';
  profField.innerHTML = '<label>Profile</label>';
  profField.appendChild(scanProfilePicker(entry));
  fields.appendChild(profField);

  // category (hidden when splitting into line items)
  const catField = document.createElement('div');
  catField.className = 'field';
  catField.innerHTML = '<label>Category</label>';
  const catSel = scanCategorySelect(entry.category);
  catSel.addEventListener('change', () => { entry.category = catSel.value; });
  catField.appendChild(catSel);
  fields.appendChild(catField);

  // note
  const noteField = document.createElement('div');
  noteField.className = 'field';
  noteField.innerHTML = '<label>Note</label>';
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.value = entry.note;
  noteInput.addEventListener('input', () => { entry.note = noteInput.value; });
  noteField.appendChild(noteInput);
  fields.appendChild(noteField);

  // line items -> optional split
  if (entry.lineItems.length) {
    const split = document.createElement('div');
    split.className = 'scan-split';
    split.innerHTML = `
      <label class="scan-split-toggle">
        <input type="checkbox" class="scan-split-cb" />
        Add ticked items as separate expenses (${entry.lineItems.length} found)
      </label>
      <div class="scan-items"></div>
    `;
    const itemsWrap = split.querySelector('.scan-items');
    entry.lineItems.forEach(item => {
      const row = document.createElement('div');
      row.className = 'scan-lineitem';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = item.checked;
      cb.addEventListener('change', () => { item.checked = cb.checked; updateScanSaveLabel(); });
      const desc = document.createElement('span');
      desc.className = 'scan-item-desc';
      desc.textContent = item.description;
      const amt = document.createElement('span');
      amt.className = 'scan-item-amt';
      amt.textContent = fmtMoney(item.amount);
      const isel = scanCategorySelect(item.category);
      isel.className = 'scan-item-cat';
      isel.addEventListener('change', () => { item.category = isel.value; });
      row.append(cb, desc, amt, isel);
      itemsWrap.appendChild(row);
    });
    const applyMode = () => {
      itemsWrap.hidden = !entry.splitMode;
      catField.hidden = entry.splitMode;
      amountField.hidden = entry.splitMode;
    };
    split.querySelector('.scan-split-cb').addEventListener('change', (e) => {
      entry.splitMode = e.target.checked;
      applyMode();
      updateScanSaveLabel();
    });
    applyMode();
    fields.appendChild(split);
  }

  return card;
}

// One profile picker that stamps its choice onto every scanned transaction at once, so a
// batch of receipts doesn't need picking a profile card-by-card. Individual cards can still
// be overridden afterward — this just sets the shared starting point.
function renderScanApplyAllPicker(selectedId) {
  const picker = document.getElementById('scanApplyAllPicker');
  picker.innerHTML = '';
  profiles.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'profile-pick-btn' + (selectedId === p.id ? ' selected' : '');
    btn.style.setProperty('--accent', p.color);
    btn.innerHTML = `<span class="emo">${p.emoji}</span><span>${escapeHtml(p.name)}</span>`;
    btn.addEventListener('click', () => applyProfileToAllScanned(p.id));
    picker.appendChild(btn);
  });
}

function applyProfileToAllScanned(profileId) {
  scanDraft.forEach(entry => { entry.profileId = profileId; });
  renderScanApplyAllPicker(profileId);
  renderScanCardsList();
}

function renderScanCardsList() {
  const results = document.getElementById('scanResults');
  results.innerHTML = '';
  scanDraft.filter(entry => entry.included).forEach(entry => results.appendChild(buildScanCard(entry)));
}

function renderScanResults(transactions) {
  const status = document.getElementById('scanStatus');
  const applyAllRow = document.getElementById('scanApplyAllRow');
  document.getElementById('scanResults').innerHTML = '';

  if (!transactions.length) {
    status.textContent = 'Nothing recognisable in those images. Try a clearer screenshot.';
    document.getElementById('scanSave').disabled = true;
    applyAllRow.hidden = true;
    return;
  }
  status.textContent = `Review and edit, then save. ${transactions.length} transaction${transactions.length === 1 ? '' : 's'} found.`;

  const defaultProfile = activeProfileFilter !== 'all' ? activeProfileFilter : (profiles[0]?.id || null);
  const today = fmtDateISO(new Date());
  const cat = (c, fallback) => (CATEGORIES.includes(c) ? c : fallback);

  scanDraft = transactions.map((t, idx) => {
    const total = Number(t.total_amount) || 0;
    const cands = (Array.isArray(t.amount_candidates) ? t.amount_candidates : [])
      .map(Number).filter(n => !isNaN(n) && n > 0);
    if (total > 0 && !cands.includes(total)) cands.unshift(total);
    const suggested = cat(t.suggested_category, 'Other');
    const lineItems = (Array.isArray(t.line_items) ? t.line_items : [])
      .map(li => ({
        description: String(li.description || '').trim() || 'Item',
        amount: Number(li.amount) || 0,
        category: cat(li.category, suggested),
        checked: true,
      }))
      .filter(li => li.amount > 0);
    const noteBits = [
      t.reference,
      t.payment_method && t.payment_method !== 'unknown' ? String(t.payment_method).toUpperCase() : '',
      t.notes,
    ].map(s => String(s || '').trim()).filter(Boolean);

    return {
      id: 'scan-' + idx,
      included: true,
      merchant: String(t.merchant || '').trim(),
      amount: total > 0 ? String(total) : '',
      direction: t.direction === 'credit' ? 'credit' : 'debit',
      date: /^\d{4}-\d{2}-\d{2}$/.test(t.date || '') ? t.date : today,
      profileId: defaultProfile,
      category: suggested,
      note: noteBits.join(' · '),
      confidence: typeof t.confidence === 'number' ? t.confidence : null,
      amountCandidates: cands,
      lineItems,
      splitMode: false,
    };
  });

  applyAllRow.hidden = profiles.length < 2;
  renderScanApplyAllPicker(defaultProfile);
  renderScanCardsList();
  updateScanSaveLabel();
}

async function handleScanFiles(fileList) {
  const files = Array.from(fileList).slice(0, MAX_SCAN_IMAGES);
  if (!files.length) return;

  const overlay = document.getElementById('scanOverlay');
  const status = document.getElementById('scanStatus');
  document.getElementById('scanResults').innerHTML = '';
  scanDraft = [];
  document.getElementById('scanSave').textContent = 'Save';
  document.getElementById('scanSave').disabled = true;
  status.innerHTML = `<span class="spinner"></span> Reading ${files.length} image${files.length === 1 ? '' : 's'}… this usually takes 5–15 seconds.`;
  overlay.classList.add('open');

  try {
    const dataUrls = await Promise.all(files.map(f => fileToScaledJpeg(f)));
    const transactions = await scanReceipts(dataUrls);
    renderScanResults(transactions);
  } catch (err) {
    status.textContent = 'Scan failed: ' + (err?.message || err);
  }
}

async function saveScanned() {
  const inserts = [];
  const problems = [];

  scanDraft.forEach((e, idx) => {
    if (!e.included) return;
    const label = e.merchant || `Transaction ${idx + 1}`;
    if (!e.profileId) { problems.push(`${label}: pick a profile`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) { problems.push(`${label}: pick a date`); return; }

    if (e.lineItems.length && e.splitMode) {
      const ticked = e.lineItems.filter(i => i.checked && i.amount > 0);
      if (!ticked.length) { problems.push(`${label}: tick at least one item`); return; }
      ticked.forEach(i => inserts.push({
        profile_id: e.profileId,
        amount: Number(i.amount),
        category: i.category,
        note: [e.merchant, i.description].filter(Boolean).join(' — ') || null,
        expense_date: e.date,
      }));
    } else {
      const amt = parseFloat(e.amount);
      if (isNaN(amt) || amt <= 0) { problems.push(`${label}: enter a valid amount`); return; }
      inserts.push({
        profile_id: e.profileId,
        amount: amt,
        category: e.category,
        note: e.note || null,
        expense_date: e.date,
      });
    }
  });

  if (problems.length) { toast(problems[0]); return; }
  if (!inserts.length) { toast('Nothing to save'); return; }

  const btn = document.getElementById('scanSave');
  btn.disabled = true;
  const { error } = await sb.from('expenses').insert(inserts);
  btn.disabled = false;
  if (error) { toast('Save failed: ' + error.message); return; }

  document.getElementById('scanOverlay').classList.remove('open');
  document.getElementById('modalOverlay').classList.remove('open');
  toast(`Added ${inserts.length} expense${inserts.length === 1 ? '' : 's'}`);

  const earliest = inserts.reduce((m, r) => (r.expense_date < m ? r.expense_date : m), inserts[0].expense_date);
  const earliestMonth = startOfMonth(new Date(earliest + 'T00:00:00'));
  if (earliestMonth.getTime() !== currentMonth.getTime()) currentMonth = earliestMonth;

  await loadAllData();
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
  await loadAllData();
  renderAll();
}

// ---------- init ----------

async function init() {
  applyStoredTheme();
  initSidebar('expenses');
  await setupAuth();

  CATEGORIES.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    document.getElementById('fCategory').appendChild(opt);
  });

  document.getElementById('prevMonth').addEventListener('click', async () => {
    currentMonth = addMonths(currentMonth, -1);
    await loadAllData();
    renderAll();
  });
  document.getElementById('nextMonth').addEventListener('click', async () => {
    currentMonth = addMonths(currentMonth, 1);
    await loadAllData();
    renderAll();
  });
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('fabAdd').addEventListener('click', openModal);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('modalSave').addEventListener('click', saveExpense);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') closeModal();
  });

  document.getElementById('scanBtn').addEventListener('click', () => document.getElementById('scanFile').click());
  document.getElementById('scanFile').addEventListener('change', (e) => {
    if (e.target.files.length) handleScanFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('scanCancel').addEventListener('click', () => document.getElementById('scanOverlay').classList.remove('open'));
  document.getElementById('scanSave').addEventListener('click', saveScanned);
  document.getElementById('scanOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'scanOverlay') document.getElementById('scanOverlay').classList.remove('open');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      document.getElementById('profileDetailOverlay').classList.remove('open');
      document.getElementById('scanOverlay').classList.remove('open');
      closeGoalModal();
    }
  });
  document.getElementById('profileDetailClose').addEventListener('click', () => {
    document.getElementById('profileDetailOverlay').classList.remove('open');
  });
  document.getElementById('profileDetailOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'profileDetailOverlay') document.getElementById('profileDetailOverlay').classList.remove('open');
  });
  document.getElementById('goalModalCancel').addEventListener('click', closeGoalModal);
  document.getElementById('goalModalSave').addEventListener('click', saveGoal);
  document.getElementById('goalModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'goalModalOverlay') closeGoalModal();
  });
  document.getElementById('toggleTableView').addEventListener('click', () => {
    chartTableView = !chartTableView;
    document.getElementById('toggleTableView').textContent = chartTableView ? 'View as chart' : 'View as table';
    renderCategoryChart();
  });
  document.getElementById('investCustomYears').addEventListener('input', updateCustomProjection);

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

  await loadAllData();
  renderAll();
}

init();
