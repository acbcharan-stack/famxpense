import {
  sb, setupLock, toast, fmtMoney, escapeHtml, fmtDateISO,
  applyStoredTheme, toggleTheme,
  PROJECTION_MILESTONES, sumInvested, totalProjected, projectedValue,
} from './common.js';

let investments = [];
let editingId = null;

async function loadInvestments() {
  const { data, error } = await sb.from('investments').select('*').order('created_at', { ascending: false });
  if (error) { toast('Error loading investments: ' + error.message); throw error; }
  investments = data || [];
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
    card.innerHTML = `
      <div class="investment-head">
        <div class="investment-type">
          ${escapeHtml(title)}
          ${inv.name ? `<span class="investment-subtype">${escapeHtml(inv.type)}</span>` : ''}
        </div>
        <button class="txn-del" title="Delete">🗑️</button>
      </div>
      <div class="investment-numbers">
        <span>Invested: <strong>${fmtMoney(inv.amount)}</strong></span>
        <span>Return: <strong>${Number(inv.annual_return)}%</strong>/yr</span>
      </div>
      <div class="investment-meta">Since ${dateStr} · Projected in 10y: ${fmtMoney(projectedValue(inv.amount, inv.annual_return, 10))}</div>
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

function openModal(inv) {
  editingId = inv ? inv.id : null;
  document.getElementById('investModalTitle').textContent = inv ? 'Edit investment' : 'Add investment';
  document.getElementById('iName').value = inv ? (inv.name || '') : '';
  document.getElementById('iType').value = inv ? inv.type : '';
  document.getElementById('iAmount').value = inv ? inv.amount : '';
  document.getElementById('iReturn').value = inv ? inv.annual_return : '';
  document.getElementById('iDate').value = inv ? inv.start_date : fmtDateISO(new Date());
  document.getElementById('investModalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('investModalOverlay').classList.remove('open');
}

async function saveInvestment() {
  const name = document.getElementById('iName').value.trim();
  const type = document.getElementById('iType').value.trim();
  const amount = parseFloat(document.getElementById('iAmount').value);
  const annualReturn = parseFloat(document.getElementById('iReturn').value);
  const startDate = document.getElementById('iDate').value;

  if (!type) { toast('Enter an investment type'); return; }
  if (isNaN(amount) || amount <= 0) { toast('Enter a valid amount'); return; }
  if (isNaN(annualReturn) || annualReturn < 0) { toast('Enter a valid expected return'); return; }
  if (!startDate) { toast('Pick a start date'); return; }

  const payload = { name: name || null, type, amount, annual_return: annualReturn, start_date: startDate };
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
  await setupLock();

  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('fabAdd').addEventListener('click', () => openModal(null));
  document.getElementById('investModalCancel').addEventListener('click', closeModal);
  document.getElementById('investModalSave').addEventListener('click', saveInvestment);
  document.getElementById('investModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'investModalOverlay') closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  document.getElementById('investCustomYears').addEventListener('input', updateCustomProjection);

  try {
    await loadInvestments();
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
