import {
  sb, setupAuth, toast, fmtMoney, escapeHtml, fmtDateISO,
  applyStoredTheme, toggleTheme, initSidebar,
  sipCurrentRate, savingsAmountToDate,
} from './common.js';

let profiles = [];
let savings = [];
let withdrawals = [];
let withdrawalsReady = true;
let selectedWdProfileId = null;
let savingsTableReady = true;
let editingSavingsId = null;
let selectedSavingsProfileId = null;
let currentSavingsMode = 'onetime';

async function loadProfiles() {
  const { data, error } = await sb.from('profiles').select('*').order('sort_order', { ascending: true });
  if (error) { toast('Error loading profiles: ' + error.message); throw error; }
  profiles = data || [];
}

// Non-fatal: if the savings table hasn't been created yet the rest of the page still
// works, and the Savings section shows a short "run the SQL" note instead.
async function loadSavings() {
  const { data, error } = await sb.from('savings').select('*').order('saved_date', { ascending: false });
  if (error) { savingsTableReady = false; savings = []; return; }
  savingsTableReady = true;
  savings = data || [];
}

// ---------- savings ----------

async function loadWithdrawals() {
  const { data, error } = await sb.from('savings_withdrawals').select('*').order('withdrawn_date', { ascending: false });
  if (error) { withdrawalsReady = false; withdrawals = []; return; }
  withdrawalsReady = true;
  withdrawals = data || [];
}

function renderSavingsProfilePicker() {
  const picker = document.getElementById('savingsProfilePicker');
  picker.innerHTML = '';
  profiles.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'profile-pick-btn' + (selectedSavingsProfileId === p.id ? ' selected' : '');
    btn.style.setProperty('--accent', p.color);
    btn.innerHTML = `<span class="emo">${p.emoji}</span><span>${escapeHtml(p.name)}</span>`;
    btn.addEventListener('click', () => {
      selectedSavingsProfileId = p.id;
      renderSavingsProfilePicker();
    });
    picker.appendChild(btn);
  });
}

function setSavingsMode(mode) {
  currentSavingsMode = mode;
  document.querySelectorAll('#savingsModeTabs .tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  document.querySelectorAll('.smode-recurring').forEach(el => { el.hidden = mode !== 'recurring'; });
  document.querySelectorAll('.smode-onetime').forEach(el => { el.hidden = mode !== 'onetime'; });
  document.getElementById('sDateLabel').textContent = mode === 'recurring' ? 'Start date' : 'Date';
}

function addSavingsChangeRow(date = '', amount = '') {
  const list = document.getElementById('savingsChangesList');
  const row = document.createElement('div');
  row.className = 'sip-change-row';
  row.innerHTML = `
    <input type="date" class="savingsChangeDate" value="${escapeHtml(date)}" />
    <input type="number" class="savingsChangeAmount" min="0.01" step="0.01" placeholder="New monthly amount" value="${escapeHtml(String(amount))}" />
    <button type="button" class="txn-del savingsChangeRemove" title="Remove">✕</button>
  `;
  row.querySelector('.savingsChangeRemove').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

function clearSavingsChangeRows() {
  document.getElementById('savingsChangesList').innerHTML = '';
}

function readSavingsChangeRows() {
  return Array.from(document.querySelectorAll('#savingsChangesList .sip-change-row')).map(row => ({
    date: row.querySelector('.savingsChangeDate').value,
    amount: parseFloat(row.querySelector('.savingsChangeAmount').value),
  }));
}

function renderSavingsCard(s) {
  const card = document.createElement('div');
  card.className = 'investment-card';
  const isRecurring = s.savings_mode === 'recurring';
  const dateStr = new Date(s.saved_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const owner = profiles.find(p => p.id === s.profile_id);
  const title = s.name ? s.name : (isRecurring ? 'Fixed monthly savings' : 'Savings');
  const metaLine = isRecurring
    ? `Fixed ${fmtMoney(sipCurrentRate(s.recurring_history))}/mo since ${dateStr}`
    : `${dateStr}${s.note ? ' · ' + escapeHtml(s.note) : ''}`;
  card.innerHTML = `
    <div class="investment-head">
      <div class="investment-type">
        ${escapeHtml(title)}
        ${isRecurring ? `<span class="investment-subtype">Monthly</span>` : ''}
        ${s.count_in_budget === false ? `<span class="investment-subtype">Not budgeted</span>` : ''}
        <span class="investment-subtype">${owner ? owner.emoji + ' ' + escapeHtml(owner.name) : 'Unassigned'}</span>
      </div>
      <button class="txn-del" title="Delete">🗑️</button>
    </div>
    <div class="investment-numbers">
      <span>Saved to date: <strong>${fmtMoney(savingsAmountToDate(s))}</strong></span>
    </div>
    <div class="investment-meta">${metaLine}${isRecurring && s.note ? ' · ' + escapeHtml(s.note) : ''}</div>
  `;
  card.addEventListener('click', (e) => {
    if (e.target.closest('.txn-del')) return;
    openSavingsModal(s);
  });
  card.querySelector('.txn-del').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteSavings(s.id);
  });
  return card;
}

function renderSavings() {
  renderWithdrawals();
  renderSavingsInner();
}

function renderSavingsInner() {
  const totalRow = document.getElementById('savingsTotalRow');
  const list = document.getElementById('savingsList');

  if (!savingsTableReady) {
    totalRow.innerHTML = '';
    list.innerHTML = `
      <div class="empty-note">
        The savings table isn't set up yet. Run the <code>savings</code> block at the end of
        <code>schema.sql</code> in the Supabase SQL editor, then reload this page.
      </div>`;
    return;
  }

  // Net of anything already spent out of savings.
  const withdrawnFor = id => withdrawals.filter(w => w.profile_id === id).reduce((a, w) => a + Number(w.amount), 0);
  const sumFor = (rows, id) => rows.reduce((a, r) => a + savingsAmountToDate(r), 0) - (id ? withdrawnFor(id) : 0);
  const totalWithdrawn = withdrawals.reduce((a, w) => a + Number(w.amount), 0);
  const total = sumFor(savings) - totalWithdrawn;
  const perProfile = profiles
    .map(p => ({ p, amt: sumFor(savings.filter(s => s.profile_id === p.id), p.id) }))
    .filter(x => x.amt !== 0);
  const unassigned = sumFor(savings.filter(s => !s.profile_id));

  totalRow.innerHTML = `
    <div class="stat-tile">
      <div class="label">Total savings${totalWithdrawn > 0 ? ' (after spending)' : ''}</div>
      <div class="value">${fmtMoney(total)}</div>
    </div>
    ${perProfile.map(({ p, amt }) => `
      <div class="stat-tile">
        <div class="label">${p.emoji} ${escapeHtml(p.name)}</div>
        <div class="value">${fmtMoney(amt)}</div>
      </div>`).join('')}
    ${unassigned > 0 ? `
      <div class="stat-tile">
        <div class="label">Unassigned</div>
        <div class="value">${fmtMoney(unassigned)}</div>
      </div>` : ''}
  `;

  list.innerHTML = '';
  if (savings.length === 0) {
    list.innerHTML = '<div class="empty-note">No savings yet. Tap “+ Add savings”.</div>';
    return;
  }
  savings.forEach(s => list.appendChild(renderSavingsCard(s)));
}

function renderWithdrawals() {
  const list = document.getElementById('withdrawalsList');
  list.innerHTML = '';
  if (!withdrawalsReady) {
    list.innerHTML = `<div class="empty-note">The savings_withdrawals table isn't set up yet. Run the <code>savings_withdrawals</code> block at the end of <code>schema.sql</code> in Supabase, then reload.</div>`;
    return;
  }
  if (withdrawals.length === 0) {
    list.innerHTML = '<div class="empty-note">Nothing spent from savings yet. Tap “− Spend from savings”.</div>';
    return;
  }
  withdrawals.forEach(w => {
    const owner = profiles.find(p => p.id === w.profile_id);
    const dateStr = new Date(w.withdrawn_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const card = document.createElement('div');
    card.className = 'investment-card';
    card.innerHTML = `
      <div class="investment-head">
        <div class="investment-type">
          ${escapeHtml(w.note || 'Spent from savings')}
          <span class="investment-subtype">${owner ? owner.emoji + ' ' + escapeHtml(owner.name) : 'Unassigned'}</span>
        </div>
        <button class="txn-del" title="Delete">🗑️</button>
      </div>
      <div class="investment-numbers"><span>Spent: <strong>${fmtMoney(w.amount)}</strong></span></div>
      <div class="investment-meta">${dateStr}</div>`;
    card.querySelector('.txn-del').addEventListener('click', () => deleteWithdrawal(w.id));
    list.appendChild(card);
  });
}

function renderWdProfilePicker() {
  const picker = document.getElementById('wdProfilePicker');
  picker.innerHTML = '';
  profiles.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'profile-pick-btn' + (selectedWdProfileId === p.id ? ' selected' : '');
    btn.style.setProperty('--accent', p.color);
    btn.innerHTML = `<span class="emo">${p.emoji}</span><span>${escapeHtml(p.name)}</span>`;
    btn.addEventListener('click', () => { selectedWdProfileId = p.id; renderWdProfilePicker(); });
    picker.appendChild(btn);
  });
}

function openWdModal() {
  selectedWdProfileId = profiles[0]?.id || null;
  renderWdProfilePicker();
  document.getElementById('wdAmount').value = '';
  document.getElementById('wdDate').value = fmtDateISO(new Date());
  document.getElementById('wdNote').value = '';
  document.getElementById('wdModalOverlay').classList.add('open');
}

function closeWdModal() {
  document.getElementById('wdModalOverlay').classList.remove('open');
}

async function saveWithdrawal() {
  const amount = parseFloat(document.getElementById('wdAmount').value);
  const date = document.getElementById('wdDate').value;
  const note = document.getElementById('wdNote').value.trim();
  if (!withdrawalsReady) { toast('Run the savings_withdrawals SQL first'); return; }
  if (!selectedWdProfileId) { toast('Pick a profile'); return; }
  if (isNaN(amount) || amount <= 0) { toast('Enter a valid amount'); return; }
  if (!date) { toast('Pick a date'); return; }
  const { error } = await sb.from('savings_withdrawals').insert({
    profile_id: selectedWdProfileId, amount, withdrawn_date: date, note: note || null,
  });
  if (error) { toast('Save failed: ' + error.message); return; }
  closeWdModal();
  toast('Spent from savings recorded');
  await loadWithdrawals();
  renderSavings();
}

async function deleteWithdrawal(id) {
  if (!confirm('Delete this entry?')) return;
  const { error } = await sb.from('savings_withdrawals').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message); return; }
  await loadWithdrawals();
  renderSavings();
  toast('Entry deleted');
}

function openSavingsModal(s) {
  editingSavingsId = s ? s.id : null;
  const isRecurring = s && s.savings_mode === 'recurring';
  selectedSavingsProfileId = s ? (s.profile_id || null) : (profiles[0]?.id || null);
  renderSavingsProfilePicker();
  document.getElementById('savingsModalTitle').textContent = s ? 'Edit savings' : 'Add savings';
  document.getElementById('sName').value = s ? (s.name || '') : '';
  document.getElementById('sDate').value = s ? s.saved_date : fmtDateISO(new Date());
  document.getElementById('sNote').value = s ? (s.note || '') : '';
  document.getElementById('sCountBudget').checked = s ? s.count_in_budget !== false : true;

  clearSavingsChangeRows();
  if (isRecurring) {
    const history = [...(s.recurring_history || [])].sort((a, b) => a.date.localeCompare(b.date));
    document.getElementById('sAmount').value = '';
    document.getElementById('sRecurringAmount').value = history.length ? history[0].amount : '';
    document.getElementById('sTopup').value = s.amount || '';
    history.slice(1).forEach(h => addSavingsChangeRow(h.date, h.amount));
  } else {
    document.getElementById('sAmount').value = s ? s.amount : '';
    document.getElementById('sRecurringAmount').value = '';
    document.getElementById('sTopup').value = '';
  }

  setSavingsMode(isRecurring ? 'recurring' : 'onetime');
  document.getElementById('savingsModalOverlay').classList.add('open');
}

function closeSavingsModal() {
  document.getElementById('savingsModalOverlay').classList.remove('open');
}

async function saveSavings() {
  const name = document.getElementById('sName').value.trim();
  const savedDate = document.getElementById('sDate').value;
  const note = document.getElementById('sNote').value.trim();
  const countInBudget = document.getElementById('sCountBudget').checked;

  if (!selectedSavingsProfileId) { toast('Pick a profile'); return; }
  if (!savedDate) { toast('Pick a date'); return; }

  let payload;

  if (currentSavingsMode === 'recurring') {
    const monthlyAmount = parseFloat(document.getElementById('sRecurringAmount').value);
    if (isNaN(monthlyAmount) || monthlyAmount <= 0) { toast('Enter a valid monthly savings amount'); return; }

    const topupRaw = document.getElementById('sTopup').value;
    const topup = topupRaw === '' ? 0 : parseFloat(topupRaw);
    if (isNaN(topup) || topup < 0) { toast('Enter a valid extra amount, or leave it blank'); return; }

    const changeRows = readSavingsChangeRows();
    for (const row of changeRows) {
      if (!row.date || isNaN(row.amount) || row.amount <= 0) {
        toast('Each amount change needs a date and a valid amount');
        return;
      }
    }

    const historyMap = new Map();
    historyMap.set(savedDate, monthlyAmount);
    changeRows.forEach(row => historyMap.set(row.date, row.amount));
    const recurringHistory = [...historyMap.entries()]
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date));

    payload = {
      profile_id: selectedSavingsProfileId,
      name: name || null,
      amount: topup,
      saved_date: recurringHistory[0].date,
      savings_mode: 'recurring',
      recurring_history: recurringHistory,
      note: note || null,
      count_in_budget: countInBudget,
    };
  } else {
    const amount = parseFloat(document.getElementById('sAmount').value);
    if (isNaN(amount) || amount <= 0) { toast('Enter a valid amount'); return; }
    payload = {
      profile_id: selectedSavingsProfileId,
      name: name || null,
      amount,
      saved_date: savedDate,
      savings_mode: 'onetime',
      recurring_history: null,
      note: note || null,
      count_in_budget: countInBudget,
    };
  }

  const { error } = editingSavingsId
    ? await sb.from('savings').update(payload).eq('id', editingSavingsId)
    : await sb.from('savings').insert(payload);

  if (error) { toast('Save failed: ' + error.message); return; }

  closeSavingsModal();
  toast(editingSavingsId ? 'Savings updated' : 'Savings added');
  await loadSavings();
  renderSavings();
}

async function deleteSavings(id) {
  if (!confirm('Delete this savings entry?')) return;
  const { error } = await sb.from('savings').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message); return; }
  await loadSavings();
  renderSavings();
  toast('Savings deleted');
}

async function init() {
  applyStoredTheme();
  initSidebar('savings');
  await setupAuth();

  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('fabAdd')?.addEventListener('click', () => openSavingsModal(null));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSavingsModal(); closeWdModal(); } });
  document.getElementById('spendSavingsBtn').addEventListener('click', openWdModal);
  document.getElementById('wdModalCancel').addEventListener('click', closeWdModal);
  document.getElementById('wdModalSave').addEventListener('click', saveWithdrawal);
  document.getElementById('wdModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'wdModalOverlay') closeWdModal();
  });
  document.getElementById('addSavingsBtn').addEventListener('click', () => openSavingsModal(null));
  document.getElementById('savingsModalCancel').addEventListener('click', closeSavingsModal);
  document.getElementById('savingsModalSave').addEventListener('click', saveSavings);
  document.getElementById('savingsModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'savingsModalOverlay') closeSavingsModal();
  });
  document.querySelectorAll('#savingsModeTabs .tab').forEach(btn => {
    btn.addEventListener('click', () => setSavingsMode(btn.dataset.mode));
  });
  document.getElementById('addSavingsChangeBtn').addEventListener('click', () => addSavingsChangeRow());

  try {
    await Promise.all([loadProfiles(), loadSavings(), loadWithdrawals()]);
  } catch {
    document.querySelector('.app').innerHTML = `
      <div class="empty-note" style="padding:60px 20px; text-align:center;">
        Could not load savings. Reload this page to try again.
      </div>`;
    return;
  }

  renderSavings();
}

init();
