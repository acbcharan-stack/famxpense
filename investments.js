import {
  sb, setupAuth, toast, fmtMoney, fmtMoneyCountry, escapeHtml, fmtDateISO,
  applyStoredTheme, toggleTheme, initSidebar,
  PROJECTION_MILESTONES, sumInvested, totalProjected,
  investedAmount, investmentProjectedValue, sipCurrentRate, averageReturn,
  investmentActualValue, totalActual, groupInvestmentsByCountry,
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

function figuresHtml(projected, actual, country) {
  return `
    <div class="figure">
      <div class="fig-label">Projected</div>
      <div class="fig-value">${fmtMoneyCountry(projected, country)}</div>
    </div>
    <div class="figure">
      <div class="fig-label">Actual (net of costs)</div>
      <div class="fig-value net">${fmtMoneyCountry(actual, country)}</div>
    </div>`;
}

function countryLabel(country) {
  return country === 'India' ? '🇮🇳 National' : `🌍 Global — ${escapeHtml(country)}`;
}

// One broad card per currency group — never sums different currencies together, since this
// app has no live exchange rates (a group is exactly the investments sharing one `country`).
function renderDashboard() {
  const container = document.getElementById('investGroups');
  const emptyNote = document.getElementById('investGroupsEmpty');
  const customYears = Math.max(1, parseInt(document.getElementById('investCustomYears').value, 10) || 1);

  if (investments.length === 0) {
    container.innerHTML = '';
    emptyNote.style.display = '';
    return;
  }
  emptyNote.style.display = 'none';

  const groups = groupInvestmentsByCountry(investments);
  container.innerHTML = groups.map(({ country, investments: groupInvestments }) => {
    const rows = [...PROJECTION_MILESTONES, customYears]
      .filter((y, i, arr) => arr.indexOf(y) === i) // dedupe if custom years matches a milestone
      .sort((a, b) => a - b)
      .map(y => `
        <div class="invest-projection-row">
          <div class="label">In ${y} year${y === 1 ? '' : 's'}</div>
          <div class="invest-projection-values">${figuresHtml(totalProjected(groupInvestments, y), totalActual(groupInvestments, y), country)}</div>
        </div>`).join('');
    return `
      <div class="invest-group-card">
        <div class="invest-group-head">
          <strong>${countryLabel(country)}</strong>
          <span class="total-invested">Total invested: <strong>${fmtMoneyCountry(sumInvested(groupInvestments), country)}</strong></span>
        </div>
        ${rows}
      </div>`;
  }).join('');
}

function updateCustomProjection() {
  renderDashboard();
}

function renderInvestmentCard(inv) {
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
  const country = inv.country || 'India';
  const costTags = [
    inv.exit_load_percent != null ? `Exit load ${inv.exit_load_percent}%` : null,
    inv.brokerage_percent != null ? `Brokerage ${inv.brokerage_percent}%` : null,
    inv.brokerage_fee != null ? `Fee ${fmtMoneyCountry(inv.brokerage_fee, country)}` : null,
    inv.count_in_budget === false ? 'Not budgeted' : null,
  ].filter(Boolean);
  const metaLine = isSip
    ? `SIP ${fmtMoneyCountry(sipRate, country)}/mo since ${dateStr}`
    : `Since ${dateStr}`;
  card.innerHTML = `
    <div class="investment-head">
      <div class="investment-type">
        ${escapeHtml(title)}
        ${inv.name ? `<span class="investment-subtype">${escapeHtml(inv.type)}</span>` : ''}
        ${isSip ? `<span class="investment-subtype">SIP</span>` : ''}
        ${country !== 'India' ? `<span class="investment-subtype">${escapeHtml(country)}</span>` : ''}
        ${costTags.map(t => `<span class="investment-subtype">${t}</span>`).join('')}
        <span class="investment-subtype">${owner ? owner.emoji + ' ' + escapeHtml(owner.name) : 'Unassigned'}</span>
      </div>
      <button class="txn-del" title="Delete">🗑️</button>
    </div>
    <div class="investment-numbers">
      <span>Invested to date: <strong>${fmtMoneyCountry(investedAmount(inv), country)}</strong></span>
      <span>Return: <strong>${returnLabel}</strong>/yr</span>
    </div>
    <div class="investment-meta">${metaLine}</div>
    <div class="invest-projection-row">
      <div class="label">In 10 years</div>
      <div class="invest-projection-values">
        <div class="figure">
          <div class="fig-label">Projected</div>
          <div class="fig-value">${fmtMoneyCountry(investmentProjectedValue(inv, 10), country)}</div>
        </div>
        <div class="figure">
          <div class="fig-label">Actual (net)</div>
          <div class="fig-value net">${fmtMoneyCountry(investmentActualValue(inv, 10), country)}</div>
        </div>
      </div>
    </div>
  `;
  card.addEventListener('click', (e) => {
    if (e.target.closest('.txn-del')) return;
    openModal(inv);
  });
  card.querySelector('.txn-del').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteInvestment(inv.id);
  });
  return card;
}

function renderList() {
  const nationalList = document.getElementById('investListNational');
  const globalList = document.getElementById('investListGlobal');
  const national = investments.filter(inv => (inv.country || 'India') === 'India');
  const global = investments.filter(inv => (inv.country || 'India') !== 'India');

  nationalList.innerHTML = '';
  if (national.length === 0) {
    nationalList.innerHTML = '<div class="empty-note">No national investments yet. Tap + to add one.</div>';
  } else {
    national.forEach(inv => nationalList.appendChild(renderInvestmentCard(inv)));
  }

  globalList.innerHTML = '';
  if (global.length === 0) {
    globalList.innerHTML = '<div class="empty-note">No global investments yet. Pick a country other than India when adding one.</div>';
  } else {
    global.forEach(inv => globalList.appendChild(renderInvestmentCard(inv)));
  }
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
  document.getElementById('iCountry').value = inv ? (inv.country || 'India') : 'India';
  document.getElementById('iExitLoad').value = inv && inv.exit_load_percent != null ? inv.exit_load_percent : '';
  document.getElementById('iBrokeragePercent').value = inv && inv.brokerage_percent != null ? inv.brokerage_percent : '';
  document.getElementById('iBrokerageFee').value = inv && inv.brokerage_fee != null ? inv.brokerage_fee : '';
  document.getElementById('iCountBudget').checked = inv ? inv.count_in_budget !== false : true;

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

  const country = document.getElementById('iCountry').value;
  const exitLoadRaw = document.getElementById('iExitLoad').value;
  const exitLoadPercent = exitLoadRaw === '' ? null : parseFloat(exitLoadRaw);
  if (exitLoadPercent != null && (isNaN(exitLoadPercent) || exitLoadPercent < 0)) {
    toast('Enter a valid exit load percentage, or leave it blank');
    return;
  }

  const brokeragePercentRaw = document.getElementById('iBrokeragePercent').value;
  const brokeragePercent = brokeragePercentRaw === '' ? null : parseFloat(brokeragePercentRaw);
  if (brokeragePercent != null && (isNaN(brokeragePercent) || brokeragePercent < 0)) {
    toast('Enter a valid brokerage percentage, or leave it blank');
    return;
  }

  const brokerageFeeRaw = document.getElementById('iBrokerageFee').value;
  const brokerageFee = brokerageFeeRaw === '' ? null : parseFloat(brokerageFeeRaw);
  if (brokerageFee != null && (isNaN(brokerageFee) || brokerageFee < 0)) {
    toast('Enter a valid brokerage fee, or leave it blank');
    return;
  }

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

  const countInBudget = document.getElementById('iCountBudget').checked;
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
      return_history: returnHistory, country, exit_load_percent: exitLoadPercent,
      brokerage_percent: brokeragePercent, brokerage_fee: brokerageFee,
      count_in_budget: countInBudget,
    };
  } else {
    const amount = parseFloat(document.getElementById('iAmount').value);
    if (isNaN(amount) || amount <= 0) { toast('Enter a valid amount'); return; }
    payload = {
      profile_id: selectedProfileId,
      name: name || null, type, amount, annual_return: annualReturn,
      start_date: startDate, investment_mode: 'lumpsum', sip_history: null,
      return_history: returnHistory, country, exit_load_percent: exitLoadPercent,
      brokerage_percent: brokeragePercent, brokerage_fee: brokerageFee,
      count_in_budget: countInBudget,
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); } });
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
