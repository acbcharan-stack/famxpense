import {
  sb, setupAuth, toast, fmtMoney, escapeHtml, fmtDateISO,
  applyStoredTheme, toggleTheme, initSidebar,
  tradeStatusInfo, tradesSummary, netExitAmount,
} from './common.js';

let trades = [];
let profiles = [];
let editingId = null;
let selectedProfileId = null;

async function loadTrades() {
  const { data, error } = await sb.from('trades').select('*').order('trade_date', { ascending: false });
  if (error) { toast('Error loading trades: ' + error.message); throw error; }
  trades = data || [];
}

async function loadProfiles() {
  const { data, error } = await sb.from('profiles').select('*').order('sort_order', { ascending: true });
  if (error) { toast('Error loading profiles: ' + error.message); throw error; }
  profiles = data || [];
}

function renderProfilePicker() {
  const picker = document.getElementById('tradeProfilePicker');
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

function renderSummary() {
  const row = document.getElementById('tradeStatRow');
  const s = tradesSummary(trades);
  row.innerHTML = `
    <div class="stat-tile">
      <div class="label">Realized P&L</div>
      <div class="value ${s.realizedGain < 0 ? 'critical' : ''}">${fmtMoney(s.realizedGain)}</div>
    </div>
    <div class="stat-tile">
      <div class="label">Realized Return</div>
      <div class="value ${s.realizedPercent < 0 ? 'critical' : ''}">${s.realizedPercent.toFixed(2)}%</div>
    </div>
    <div class="stat-tile">
      <div class="label">Win Rate (${s.closedCount} closed)</div>
      <div class="value">${s.closedCount > 0 ? s.winRate.toFixed(0) + '%' : '—'}</div>
    </div>
    <div class="stat-tile">
      <div class="label">Open Positions</div>
      <div class="value">${s.openCount} · ${fmtMoney(s.openInvested)}</div>
    </div>`;
}

function renderList() {
  const list = document.getElementById('tradeList');
  if (trades.length === 0) {
    list.innerHTML = '<div class="empty-note">No trades yet. Tap + to log one.</div>';
    return;
  }
  list.innerHTML = '';
  trades.forEach(t => {
    const info = tradeStatusInfo(t);
    const card = document.createElement('div');
    const owner = profiles.find(p => p.id === t.profile_id);
    const dateStr = new Date(t.trade_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const targetDateStr = info.targetDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    let badge, cardClass, metaLine, numbersLine;
    if (info.closed) {
      const win = info.hitTarget;
      badge = `<span class="trade-badge ${win ? 'win' : 'loss'}">${win ? 'Target hit' : 'Below target'}</span>`;
      cardClass = win ? 'closed-win' : 'closed-loss';
      const gainClass = info.amount >= 0 ? 'good' : 'critical';
      numbersLine = `
        <span>Invested: <strong>${fmtMoney(t.invested_amount)}</strong></span>
        <span>Exited: <strong>${fmtMoney(t.exit_amount)}</strong></span>
        <span>Gain: <strong class="${gainClass}">${info.amount >= 0 ? '+' : ''}${fmtMoney(info.amount)} (${info.percent.toFixed(2)}%)</strong></span>`;
      const exitDateStr = t.exit_date ? new Date(t.exit_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
      const loadStr = t.exit_load_percent != null ? ` · Exit load ${t.exit_load_percent}%` : '';
      metaLine = `Invested ${dateStr} · Exited ${exitDateStr} (target was ${t.target_percent}% by ${targetDateStr})${loadStr}`;
    } else {
      const overdue = info.overdue;
      badge = overdue
        ? `<span class="trade-badge overdue">Overdue ${Math.abs(info.daysLeft)}d</span>`
        : `<span class="trade-badge open">${info.daysLeft}d to target</span>`;
      cardClass = overdue ? 'overdue' : '';
      numbersLine = `
        <span>Invested: <strong>${fmtMoney(t.invested_amount)}</strong></span>
        <span>Target: <strong>${t.target_percent}%</strong></span>`;
      metaLine = `Invested ${dateStr} · Target by ${targetDateStr} (${t.period_value} ${t.period_unit})`;
    }

    card.className = `trade-card ${cardClass}`;
    card.innerHTML = `
      <div class="trade-head">
        <div class="trade-symbol">${escapeHtml(t.symbol)} <span class="investment-subtype">${owner ? owner.emoji + ' ' + escapeHtml(owner.name) : 'Unassigned'}</span></div>
        <div style="display:flex; align-items:center; gap:8px;">
          ${badge}
          <button class="txn-del" title="Delete">🗑️</button>
        </div>
      </div>
      <div class="trade-numbers">${numbersLine}</div>
      <div class="trade-meta">${metaLine}${t.quantity ? ` · Qty ${t.quantity}${t.entry_price ? ' @ ' + fmtMoney(t.entry_price) : ''}` : ''}</div>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.txn-del')) return;
      openModal(t);
    });
    card.querySelector('.txn-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTrade(t.id);
    });
    list.appendChild(card);
  });
}

async function deleteTrade(id) {
  if (!confirm('Delete this trade?')) return;
  const { error } = await sb.from('trades').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message); return; }
  await loadTrades();
  renderAll();
  toast('Trade deleted');
}

function setExitVisible(visible) {
  document.getElementById('exitFields').hidden = !visible;
  document.getElementById('tExitToggle').checked = visible;
}

function updateInvestedFromEntry() {
  const qty = parseFloat(document.getElementById('tQuantity').value);
  const price = parseFloat(document.getElementById('tEntryPrice').value);
  const hint = document.getElementById('investedHint');
  if (!isNaN(qty) && qty > 0 && !isNaN(price) && price >= 0) {
    document.getElementById('tInvested').value = (qty * price).toFixed(2);
    hint.textContent = `Auto-calculated as ${qty} × ${fmtMoney(price)}.`;
  } else {
    hint.textContent = '';
  }
}

function updateExitGainHint() {
  const qty = parseFloat(document.getElementById('tQuantity').value);
  const exitPrice = parseFloat(document.getElementById('tExitPrice').value);
  const hint = document.getElementById('exitGainHint');
  if (!isNaN(qty) && qty > 0 && !isNaN(exitPrice) && exitPrice >= 0) {
    document.getElementById('tExitAmount').value = (qty * exitPrice).toFixed(2);
  }
  const invested = parseFloat(document.getElementById('tInvested').value);
  const exitAmount = parseFloat(document.getElementById('tExitAmount').value);
  const exitLoadRaw = document.getElementById('tExitLoad').value;
  const exitLoadPercent = exitLoadRaw === '' ? 0 : parseFloat(exitLoadRaw);
  if (!isNaN(invested) && invested > 0 && !isNaN(exitAmount) && !isNaN(exitLoadPercent)) {
    const net = netExitAmount({ exit_amount: exitAmount, exit_load_percent: exitLoadPercent });
    const gain = net - invested;
    const pct = (gain / invested) * 100;
    const loadNote = exitLoadPercent > 0 ? ` after ${exitLoadPercent}% exit load (net ${fmtMoney(net)})` : '';
    hint.textContent = `${gain >= 0 ? '+' : ''}${fmtMoney(gain)} (${pct.toFixed(2)}%) vs. amount invested${loadNote}.`;
  } else {
    hint.textContent = '';
  }
}

function openModal(t) {
  editingId = t ? t.id : null;
  selectedProfileId = t ? (t.profile_id || null) : (profiles[0]?.id || null);
  renderProfilePicker();
  document.getElementById('tradeModalTitle').textContent = t ? 'Edit trade' : 'Add trade';
  document.getElementById('tSymbol').value = t ? t.symbol : '';
  document.getElementById('tQuantity').value = t && t.quantity != null ? t.quantity : '';
  document.getElementById('tEntryPrice').value = t && t.entry_price != null ? t.entry_price : '';
  document.getElementById('tInvested').value = t ? t.invested_amount : '';
  document.getElementById('tDate').value = t ? t.trade_date : fmtDateISO(new Date());
  document.getElementById('tPeriodValue').value = t ? t.period_value : 7;
  document.getElementById('tPeriodUnit').value = t ? t.period_unit : 'days';
  document.getElementById('tTargetPercent').value = t ? t.target_percent : '';
  document.getElementById('tNotes').value = t && t.notes ? t.notes : '';
  document.getElementById('investedHint').textContent = '';

  const isClosed = t && t.status === 'closed';
  setExitVisible(isClosed);
  document.getElementById('tExitDate').value = isClosed ? t.exit_date : fmtDateISO(new Date());
  document.getElementById('tExitPrice').value = isClosed && t.exit_price != null ? t.exit_price : '';
  document.getElementById('tExitAmount').value = isClosed && t.exit_amount != null ? t.exit_amount : '';
  document.getElementById('tExitLoad').value = isClosed && t.exit_load_percent != null ? t.exit_load_percent : '';
  document.getElementById('exitGainHint').textContent = '';

  document.getElementById('tradeModalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('tradeModalOverlay').classList.remove('open');
}

async function saveTrade() {
  const symbol = document.getElementById('tSymbol').value.trim();
  const quantityRaw = document.getElementById('tQuantity').value;
  const entryPriceRaw = document.getElementById('tEntryPrice').value;
  const invested = parseFloat(document.getElementById('tInvested').value);
  const tradeDate = document.getElementById('tDate').value;
  const periodValue = parseInt(document.getElementById('tPeriodValue').value, 10);
  const periodUnit = document.getElementById('tPeriodUnit').value;
  const targetPercent = parseFloat(document.getElementById('tTargetPercent').value);
  const notes = document.getElementById('tNotes').value.trim();

  if (!selectedProfileId) { toast('Pick a profile'); return; }
  if (!symbol) { toast('Enter a stock/trade name'); return; }
  if (isNaN(invested) || invested <= 0) { toast('Enter a valid amount invested'); return; }
  if (!tradeDate) { toast('Pick the date of investment'); return; }
  if (isNaN(periodValue) || periodValue <= 0) { toast('Enter a valid time period'); return; }
  if (isNaN(targetPercent) || targetPercent < 0) { toast('Enter a valid target percentage'); return; }

  const isExited = document.getElementById('tExitToggle').checked;
  let exitDate = null, exitAmount = null, exitPrice = null, exitLoadPercent = null;
  if (isExited) {
    exitDate = document.getElementById('tExitDate').value;
    exitAmount = parseFloat(document.getElementById('tExitAmount').value);
    const exitPriceRaw = document.getElementById('tExitPrice').value;
    exitPrice = exitPriceRaw === '' ? null : parseFloat(exitPriceRaw);
    const exitLoadRaw = document.getElementById('tExitLoad').value;
    exitLoadPercent = exitLoadRaw === '' ? null : parseFloat(exitLoadRaw);
    if (!exitDate) { toast('Pick the exit date'); return; }
    if (isNaN(exitAmount) || exitAmount < 0) { toast('Enter a valid exit amount'); return; }
    if (exitLoadPercent != null && (isNaN(exitLoadPercent) || exitLoadPercent < 0)) {
      toast('Enter a valid exit load percentage, or leave it blank');
      return;
    }
  }

  const payload = {
    profile_id: selectedProfileId,
    symbol,
    quantity: quantityRaw === '' ? null : parseFloat(quantityRaw),
    entry_price: entryPriceRaw === '' ? null : parseFloat(entryPriceRaw),
    invested_amount: invested,
    trade_date: tradeDate,
    period_value: periodValue,
    period_unit: periodUnit,
    target_percent: targetPercent,
    notes: notes || null,
    status: isExited ? 'closed' : 'open',
    exit_date: exitDate,
    exit_amount: exitAmount,
    exit_price: exitPrice,
    exit_load_percent: exitLoadPercent,
  };

  const { error } = editingId
    ? await sb.from('trades').update(payload).eq('id', editingId)
    : await sb.from('trades').insert(payload);

  if (error) { toast('Save failed: ' + error.message); return; }

  closeModal();
  toast(editingId ? 'Trade updated' : 'Trade added');
  await loadTrades();
  renderAll();
}

function renderAll() {
  renderSummary();
  renderList();
}

async function init() {
  applyStoredTheme();
  initSidebar('trades');
  await setupAuth();

  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('fabAdd').addEventListener('click', () => openModal(null));
  document.getElementById('tradeModalCancel').addEventListener('click', closeModal);
  document.getElementById('tradeModalSave').addEventListener('click', saveTrade);
  document.getElementById('tradeModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'tradeModalOverlay') closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  document.getElementById('tQuantity').addEventListener('input', () => { updateInvestedFromEntry(); updateExitGainHint(); });
  document.getElementById('tEntryPrice').addEventListener('input', updateInvestedFromEntry);
  document.getElementById('tInvested').addEventListener('input', updateExitGainHint);
  document.getElementById('tExitPrice').addEventListener('input', updateExitGainHint);
  document.getElementById('tExitAmount').addEventListener('input', updateExitGainHint);
  document.getElementById('tExitLoad').addEventListener('input', updateExitGainHint);
  document.getElementById('exitToggleRow').addEventListener('click', (e) => {
    if (e.target.id === 'tExitToggle') return;
    setExitVisible(!document.getElementById('tExitToggle').checked);
  });
  document.getElementById('tExitToggle').addEventListener('change', (e) => setExitVisible(e.target.checked));

  try {
    await Promise.all([loadTrades(), loadProfiles()]);
  } catch {
    document.querySelector('.app').innerHTML = `
      <div class="empty-note" style="padding:60px 20px; text-align:center;">
        Could not load trades. Make sure you've run the updated <code>schema.sql</code>
        (with the trades table) in the Supabase SQL editor, then reload this page.
      </div>`;
    return;
  }

  renderAll();
}

init();
