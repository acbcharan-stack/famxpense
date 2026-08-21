import {
  sb, setupAuth, signOut, toast, fmtMoney, escapeHtml, fmtDateISO,
  applyStoredTheme, toggleTheme, initSidebar,
  PROJECTION_MILESTONES, sumInvested, totalProjected,
  investedAmount, investmentProjectedValue, sipCurrentRate, averageReturn,
} from './common.js';

let investments = [];
let profiles = [];
let editingId = null;
let currentMode = 'lumpsum';
let selectedProfileId = null;

async function loadInvestments() {
  const { data, error } = await sb.from('investments').select('*').order('created_at', { ascending: false });
  if (error) { toast('Error loading investments: ' + error.message); throw error; }
  investments = data || [];
}

async function loadProfiles() {
  const { data, error } = await sb.from('profiles').select('*').order('sort_order', { ascending: true });
  if (error) { toast('Error loading profiles: ' + error.message); throw error; }
  profiles = data || [];
}

function renderProfilePicker() {
  const picker = document.getElementById('investProfilePicker');
  picker.innerHTML = '';
  profiles.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'profile-pick-btn' + (selectedProfileId === p.id ? ' selected' : '');
    btn.style.setProperty('--accent', p.color);
    btn.innerHTML = `<span class="emo">${p.emoji}</span><span>${escapeHtml(p.name)}</span>`;
    btn.addEventListener('click', () => {
      selectedProfileId = p.id;
      renderProfilePicker();
    });
    picker.appendChild(btn);
  });
}

function renderDashboard() {
  const row = document.getElementById('investStatRow');
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
  updateCustomProjection();
}

function updateCustomProjection() {
  const yearsInput = document.getElementById('investCustomYears');
  const years = Math.max(1, parseInt(yearsInput.value, 10) || 1);
  document.getElementById('investCustomValue').textContent = fmtMoney(totalProjected(investments, years));
}

function renderList() {
  const list = document.getElementById('investList');
  if (investments.length === 0) {
    list.innerHTML = '<div class="empty-note">No investments yet. Tap + to add one.</div>';
    return;
  }
  list.innerHTML = '';
  investments.forEach(inv => {
    const card = document.createElement('div');
    card.className = 'investment-card';
    const dateStr = new Date(inv.start_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const title = inv.name ? inv.name : inv.type;
    const isSip = inv.investment_mode === 'sip';
    const sipRate = isSip ? sipCurrentRate(inv.sip_history) : 0;
    const hasReturnHistory = Array.isArray(inv.return_history) && inv.return_history.length > 1;
    const returnLabel = hasReturnHistory
      ? `${averageReturn(inv).toFixed(2)}% avg`
      : `${Number(averageReturn(inv))}%`;
    const owner = profiles.find(p => p.id === inv.profile_id);
    const metaLine = isSip
      ? `SIP ${fmtMoney(sipRate)}/mo since ${dateStr} · Projected in 10y: ${fmtMoney(investmentProjectedValue(inv, 10))}`
      : `Since ${dateStr} · Projected in 10y: ${fmtMoney(investmentProjectedValue(inv, 10))}`;
    card.innerHTML = `
      <div class="investment-head">
        <div class="investment-type">
          ${escapeHtml(title)}
          ${inv.name ? `<span class="investment-subtype">${escapeHtml(inv.type)}</span>` : ''}
          ${isSip ? `<span class="investment-subtype">SIP</span>` : ''}
          <span class="investment-subtype">${owner ? owner.emoji + ' ' + escapeHtml(owner.name) : 'Unassigned'}</span>
        </div>
        <button class="txn-del" title="Delete">🗑️</button>
      </div>
      <div class="investment-numbers">
        <span>Invested to date: <strong>${fmtMoney(investedAmount(inv))}</strong></span>
        <span>Return: <strong>${returnLabel}</strong>/yr</span>
      </div>
      <div class="investment-meta">${metaLine}</div>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.txn-del')) return;
      openModal(inv);
    });
    card.querySelector('.txn-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteInvestment(inv.id);
    });
    list.appendChild(card);
  });
}

async function deleteInvestment(id) {
  if (!confirm('Delete this investment?')) return;
  const { error } = await sb.from('investments').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message); return; }
  await loadInvestments();
  renderAll();
  toast('Investment deleted');
}

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('#investModeTabs .tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  document.querySelectorAll('.mode-sip').forEach(el => { el.hidden = mode !== 'sip'; });
  document.querySelectorAll('.mode-lumpsum').forEach(el => { el.hidden = mode !== 'lumpsum'; });
  document.getElementById('iAmountLabel').textContent = mode === 'sip'
    ? 'Amount already invested before this SIP (optional)'
    : 'Amount invested';
  document.getElementById('iDateLabel').textContent = mode === 'sip' ? 'SIP start date' : 'Start date';
}

function addSipChangeRow(date = '', amount = '') {
  const list = document.getElementById('sipChangesList');
  const row = document.createElement('div');
  row.className = 'sip-change-row';
  row.innerHTML = `
    <input type="date" class="sipChangeDate" value="${escapeHtml(date)}" />
    <input type="number" class="sipChangeAmount" min="0.01" step="0.01" placeholder="New monthly amount" value="${escapeHtml(String(amount))}" />
    <button type="button" class="txn-del sipChangeRemove" title="Remove">✕</button>
  `;
  row.querySelector('.sipChangeRemove').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

function clearSipChangeRows() {
  document.getElementById('sipChangesList').innerHTML = '';
}

function readSipChangeRows() {
  return Array.from(document.querySelectorAll('#sipChangesList .sip-change-row')).map(row => ({
    date: row.querySelector('.sipChangeDate').value,
    amount: parseFloat(row.querySelector('.sipChangeAmount').value),
  }));
}

function addReturnChangeRow(date = '', rate = '') {
  const list = document.getElementById('returnChangesList');
  const row = document.createElement('div');
  row.className = 'sip-change-row';
  row.innerHTML = `
    <input type="date" class="returnChangeDate" value="${escapeHtml(date)}" />
    <input type="number" class="returnChangeRate" min="0" step="0.1" placeholder="New annual return %" value="${escapeHtml(String(rate))}" />
    <button type="button" class="txn-del returnChangeRemove" title="Remove">✕</button>
  `;
  row.querySelector('.returnChangeRemove').addEventListener('click', () => { row.remove(); updateReturnAvgHint(); });
  list.appendChild(row);
  updateReturnAvgHint();
}

function clearReturnChangeRows() {
  document.getElementById('returnChangesList').innerHTML = '';
}

function readReturnChangeRows() {
  return Array.from(document.querySelectorAll('#returnChangesList .sip-change-row')).map(row => ({
    date: row.querySelector('.returnChangeDate').value,
    rate: parseFloat(row.querySelector('.returnChangeRate').value),
  }));
}

function updateReturnAvgHint() {
  const initial = parseFloat(document.getElementById('iReturn').value);
  const rows = readReturnChangeRows().filter(r => !isNaN(r.rate));
  const rates = [...(isNaN(initial) ? [] : [initial]), ...rows.map(r => r.rate)];
  const hint = document.getElementById('returnAvgHint');
  if (rates.length > 1) {
    const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
    hint.textContent = `Average of ${rates.length} updates: ${avg.toFixed(2)}%/yr — used for projections.`;
  } else {
    hint.textContent = '';
  }
}

function openModal(inv) {
  editingId = inv ? inv.id : null;
  const isSip = inv && inv.investment_mode === 'sip';
  selectedProfileId = inv ? (inv.profile_id || null) : (profiles[0]?.id || null);
  renderProfilePicker();
  document.getElementById('investModalTitle').textContent = inv ? 'Edit investment' : 'Add investment';
  document.getElementById('iName').value = inv ? (inv.name || '') : '';
  document.getElementById('iType').value = inv ? inv.type : '';
  document.getElementById('iDate').value = inv ? inv.start_date : fmtDateISO(new Date());

  clearSipChangeRows();
  if (isSip) {
    const history = [...(inv.sip_history || [])].sort((a, b) => a.date.localeCompare(b.date));
    document.getElementById('iAmount').value = '';
    document.getElementById('iSipAmount').value = history.length ? history[0].amount : '';
    document.getElementById('iSipTopup').value = inv.amount || '';
    history.slice(1).forEach(h => addSipChangeRow(h.date, h.amount));
  } else {
    document.getElementById('iAmount').value = inv ? inv.amount : '';
    document.getElementById('iSipAmount').value = '';
    document.getElementById('iSipTopup').value = '';
  }

  clearReturnChangeRows();
  const returnHistory = inv ? [...(inv.return_history || [])].sort((a, b) => a.date.localeCompare(b.date)) : [];
  document.getElementById('iReturn').value = returnHistory.length ? returnHistory[0].rate : (inv ? inv.annual_return : '');
  returnHistory.slice(1).forEach(h => addReturnChangeRow(h.date, h.rate));
  updateReturnAvgHint();

  setMode(isSip ? 'sip' : 'lumpsum');
  document.getElementById('investModalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('investModalOverlay').classList.remove('open');
}

async function saveInvestment() {
  const name = document.getElementById('iName').value.trim();
  const type = document.getElementById('iType').value.trim();
  const annualReturn = parseFloat(document.getElementById('iReturn').value);
  const startDate = document.getElementById('iDate').value;

  if (!selectedProfileId) { toast('Pick a profile'); return; }
  if (!type) { toast('Enter an investment type'); return; }
  if (isNaN(annualReturn) || annualReturn < 0) { toast('Enter a valid expected return'); return; }
  if (!startDate) { toast('Pick a start date'); return; }

  const returnChangeRows = readReturnChangeRows();
  for (const row of returnChangeRows) {
    if (!row.date || isNaN(row.rate) || row.rate < 0) {
      toast('Each return-rate update needs a date and a valid rate');
      return;
    }
  }
  const returnHistoryMap = new Map();
  returnHistoryMap.set(startDate, annualReturn);
  returnChangeRows.forEach(row => returnHistoryMap.set(row.date, row.rate));
  const returnHistory = [...returnHistoryMap.entries()]
    .map(([date, rate]) => ({ date, rate }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let payload;

  if (currentMode === 'sip') {
    const sipAmount = parseFloat(document.getElementById('iSipAmount').value);
    if (isNaN(sipAmount) || sipAmount <= 0) { toast('Enter a valid monthly SIP amount'); return; }

    const topupRaw = document.getElementById('iSipTopup').value;
    const topup = topupRaw === '' ? 0 : parseFloat(topupRaw);
    if (isNaN(topup) || topup < 0) { toast('Enter a valid extra amount, or leave it blank'); return; }

    const changeRows = readSipChangeRows();
    for (const row of changeRows) {
      if (!row.date || isNaN(row.amount) || row.amount <= 0) {
        toast('Each SIP change needs a date and a valid amount');
        return;
      }
    }

    const historyMap = new Map();
    historyMap.set(startDate, sipAmount);
    changeRows.forEach(row => historyMap.set(row.date, row.amount));
    const sipHistory = [...historyMap.entries()]
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date));

    payload = {
      profile_id: selectedProfileId,
      name: name || null, type, amount: topup, annual_return: annualReturn,
      start_date: sipHistory[0].date, investment_mode: 'sip', sip_history: sipHistory,
      return_history: returnHistory,
    };
  } else {
    const amount = parseFloat(document.getElementById('iAmount').value);
    if (isNaN(amount) || amount <= 0) { toast('Enter a valid amount'); return; }
    payload = {
      profile_id: selectedProfileId,
      name: name || null, type, amount, annual_return: annualReturn,
      start_date: startDate, investment_mode: 'lumpsum', sip_history: null,
      return_history: returnHistory,
    };
  }

  const { error } = editingId
    ? await sb.from('investments').update(payload).eq('id', editingId)
    : await sb.from('investments').insert(payload);

  if (error) { toast('Save failed: ' + error.message); return; }

  closeModal();
  toast(editingId ? 'Investment updated' : 'Investment added');
  await loadInvestments();
  renderAll();
}

function renderAll() {
  renderDashboard();
  renderList();
}

async function init() {
  applyStoredTheme();
  initSidebar('investments');
  await setupAuth();
  document.getElementById('signOutBtn').addEventListener('click', signOut);

  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('fabAdd').addEventListener('click', () => openModal(null));
  document.getElementById('investModalCancel').addEventListener('click', closeModal);
  document.getElementById('investModalSave').addEventListener('click', saveInvestment);
  document.querySelectorAll('#investModeTabs .tab').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
  document.getElementById('addSipChangeBtn').addEventListener('click', () => addSipChangeRow());
  document.getElementById('addReturnChangeBtn').addEventListener('click', () => addReturnChangeRow());
  document.getElementById('iReturn').addEventListener('input', updateReturnAvgHint);
  document.getElementById('returnChangesList').addEventListener('input', updateReturnAvgHint);
  document.getElementById('investModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'investModalOverlay') closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  document.getElementById('investCustomYears').addEventListener('input', updateCustomProjection);

  try {
    await Promise.all([loadInvestments(), loadProfiles()]);
  } catch {
    document.querySelector('.app').innerHTML = `
      <div class="empty-note" style="padding:60px 20px; text-align:center;">
        Could not load investments. Make sure you've run the updated <code>schema.sql</code>
        (with the investments table) in the Supabase SQL editor, then reload this page.
      </div>`;
    return;
  }

  renderAll();
}

init();
