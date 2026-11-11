'use strict';

const KEY = 'fuloosi-v3';
const CURRENCIES = ['IQD', 'JOD', 'USD'];
const labels = { IQD: '🇮🇶 عراقي', JOD: '🇯🇴 أردني', USD: '🇺🇸 دولار' };
const uid = () => crypto.randomUUID();
const today = () => new Date().toLocaleDateString('en-CA');
const thisMonth = () => today().slice(0, 7);
const initial = () => ({
  accounts: [],
  entries: [],
  transfers: [],
  budgets: FuloosiCore.defaultBudgets(),
  debt_people: [],
  debt_entries: [],
  settings: { iqd_per_usd: 1679, jod_per_usd: 0.709, monthly_budget_jod: 600 }
});

let local = initial();
let localRaw = null;
let storageBroken = false;
try {
  const raw = localStorage.getItem(KEY);
  localRaw = raw;
  if (raw) local = FuloosiCore.validate(JSON.parse(raw));
} catch (error) {
  storageBroken = true;
  setTimeout(() => alert('تعذر قراءة البيانات المحلية؛ احتفظنا بالنص الأصلي دون استبداله. ' + error.message), 0);
}

const needsLogin = () => Boolean(window.FULOOSI_CONFIG?.requireAuth);
let state = needsLogin() ? initial() : local;
let client = null;
let cloud = false;
let currentUser = null;
let authSubscription = null;
let epoch = 0;
let loading = null;
let busy = false;
let cloudReady = false;

let accountEditId = null;
let accountRevision = null;
let balanceDraft = null;
let entryEditId = null;
let entryRevision = null;
let entryDraft = null;
let budgetEditCategory = null;
let budgetRevision = null;
let personEditId = null;
let personRevision = null;
let debtEditId = null;
let debtRevision = null;
let debtDraft = null;
let settlementDraft = null;
let settingsDirty = false;
let settingsRevision = null;
let reportUrl = null;

const num = value => Number(value || 0);
const fmt = (value, currency = 'JOD') => new Intl.NumberFormat('en-US', {
  minimumFractionDigits: currency === 'IQD' ? 0 : 2,
  maximumFractionDigits: 3
}).format(num(value));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const enc = value => encodeURIComponent(String(value));

function saveLocal() {
  if (storageBroken) throw Error('التخزين المحلي غير متاح؛ لم نحذف بياناتك');
  localStorage.setItem(KEY, JSON.stringify(local));
}

function localMutation(change) {
  if (needsLogin()) throw Error('سجل الدخول أولاً لحفظ بياناتك على السحابة');
  if (storageBroken) throw Error('تعذر قراءة التخزين؛ لم نغير بياناتك');
  if (localStorage.getItem(KEY) !== localRaw) throw Error('تغيرت البيانات في نافذة أخرى. حدّث الصفحة أولاً.');
  const next = structuredClone(local);
  change(next);
  const validated = FuloosiCore.validate(next);
  localStorage.setItem(KEY, JSON.stringify(validated));
  localRaw = JSON.stringify(validated);
  local = validated;
  state = local;
}

async function action(task) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    return await task();
  } catch (error) {
    msg(error.message);
    alert(error.message);
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
}

function bal(account) {
  return FuloosiCore.balance(account, state.entries, state.transfers, state.debt_entries);
}

function render() {
  const sums = Object.fromEntries(CURRENCIES.map(currency => [
    currency,
    state.accounts.filter(account => account.currency === currency).reduce((sum, account) => sum + bal(account), 0)
  ]));
  document.getElementById('tiles').innerHTML = CURRENCIES.map(currency => `
    <div class="tile">
      <small>${labels[currency]}</small>
      <strong class="${sums[currency] < 0 ? 'negative' : ''}">${fmt(sums[currency], currency)}</strong>
      <small>${currency} · ${state.accounts.filter(account => account.currency === currency).length} حساب</small>
    </div>
  `).join('');

  const settings = state.settings;
  const toUsd = amounts => amounts.USD + amounts.IQD / num(settings.iqd_per_usd) + amounts.JOD / num(settings.jod_per_usd);
  const walletTotal = toUsd(sums);
  const netTotal = walletTotal + toUsd(FuloosiCore.debtNet(null, state.debt_entries));
  for (const [id, amount] of [['total', walletTotal], ['totalAfterDebts', netTotal]]) {
    const element = document.getElementById(id);
    element.textContent = fmt(amount, 'USD') + ' USD';
    element.classList.toggle('negative', amount < 0);
    const iqdEquivalent = document.getElementById(id + 'Iqd');
    iqdEquivalent.textContent = '≈ ' + fmt(amount * num(settings.iqd_per_usd), 'IQD') + ' IQD';
    iqdEquivalent.classList.toggle('negative', amount < 0);
  }
  document.getElementById('ratesText').textContent = `1 USD = ${settings.iqd_per_usd} IQD = ${settings.jod_per_usd} JOD`;
  if (!settingsDirty) {
    document.getElementById('iqdRate').value = settings.iqd_per_usd;
    document.getElementById('jodRate').value = settings.jod_per_usd;
    document.getElementById('monthlyBudget').value = settings.monthly_budget_jod ?? 600;
  }

  renderAccounts();
  renderEntries();
  renderCategories();
  renderTransfers();
  renderStats();
  renderDebts();
}

function renderAccounts() {
  document.getElementById('accountList').innerHTML = CURRENCIES.map(currency => `
    <h3>${labels[currency]}</h3>
    ${state.accounts.filter(account => account.currency === currency).map(account => {
      const amount = bal(account);
      const formatted = fmt(amount, currency);
      return `
      <div class="item">
        <div><b>${escapeHtml(account.name)}</b><br><small>${currency}</small></div>
        <div style="text-align:left">
          <button type="button" class="amount balance-button ${amount < 0 ? 'negative' : ''}" onclick="showBalanceForm('${account.id}')" aria-label="تعديل رصيد ${escapeHtml(account.name)}، ${formatted} ${currency}">${formatted}</button>
          <div class="controls">
            <button onclick="showAccountForm('${account.id}')">تعديل</button>
            <button class="danger" onclick="deleteAccount('${account.id}')">حذف</button>
          </div>
        </div>
      </div>
      `;
    }).join('') || '<small>لا توجد حسابات</small>'}
  `).join('');
}

function renderCategories() {
  const select = document.getElementById('category');
  const selected = select.value;
  const { balanceAdjustmentCategory } = FuloosiCore;
  const categories = new Set([
    ...FuloosiCore.defaultBudgets().map(row => row.category),
    ...state.budgets.map(row => row.category),
    ...state.entries.map(row => row.category),
    '💰 تحويل أو إيداع',
    'أخرى'
  ].filter(category => category !== balanceAdjustmentCategory));
  if (entryDraft?.category === balanceAdjustmentCategory) categories.add(balanceAdjustmentCategory);
  select.innerHTML = [...categories].map(category => `<option>${escapeHtml(category)}</option>`).join('');
  if ([...categories].includes(selected)) select.value = selected;

  const accountSelect = document.getElementById('entryAccount');
  const selectedAccount = accountSelect.value;
  accountSelect.innerHTML = state.accounts.map(account => `<option value="${account.id}">${escapeHtml(account.name)} — ${account.currency} (${fmt(bal(account), account.currency)})</option>`).join('');
  if (state.accounts.some(account => account.id === selectedAccount)) accountSelect.value = selectedAccount;
}

function renderEntries() {
  const query = document.getElementById('search').value.trim().toLowerCase();
  const currency = document.getElementById('filterCurrency').value;
  const settlements = state.debt_entries.filter(debt => debt.settlement_account_id).map(debt => {
    const person = state.debt_people.find(row => row.id === debt.person_id);
    const received = debt.direction === 'i_owe';
    return {
      ...debt,
      account_id: debt.settlement_account_id,
      kind: received ? 'income' : 'expense',
      category: received ? 'استلام تسديد دين' : 'دفع تسديد دين',
      note: [person?.name, debt.note].filter(Boolean).join(' · ')
    };
  });
  const rows = [...state.entries, ...settlements]
    .sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .filter(entry => {
      const account = state.accounts.find(row => row.id === entry.account_id);
      return account && (!currency || account.currency === currency) && (!query || [account.name, entry.category, entry.note].join(' ').toLowerCase().includes(query));
    });

  document.getElementById('entryList').innerHTML = rows.length ? rows.map(entry => {
    const account = state.accounts.find(row => row.id === entry.account_id);
    return `
      <div class="item">
        <div><b>${escapeHtml(entry.category)}</b><br><small>${escapeHtml(account.name)} · ${escapeHtml(entry.occurred_on)} · ${escapeHtml(entry.note || '')}</small></div>
        <div style="text-align:left">
          <strong class="amount ${entry.kind === 'expense' ? 'negative' : 'good'}">${entry.kind === 'expense' ? '−' : '+'}${fmt(entry.amount, account.currency)} ${account.currency}</strong>
          <div class="controls">${entry.settlement_account_id
            ? `<button class="danger" onclick="deleteDebtEntry('${entry.id}')">حذف التسديد</button>`
            : `<button onclick="editEntry('${entry.id}')">تعديل</button><button class="danger" onclick="deleteEntry('${entry.id}')">حذف</button>`}</div>
        </div>
      </div>
    `;
  }).join('') : '<p class="muted">ماكو عمليات مسجلة بعد.</p>';

  document.getElementById('expenseSummary').textContent = 'مصاريف اليوم: ' + CURRENCIES.map(code => {
    const total = state.entries.filter(entry => FuloosiCore.isSpending(entry) && entry.occurred_on === today() && state.accounts.find(account => account.id === entry.account_id)?.currency === code).reduce((sum, entry) => sum + num(entry.amount), 0);
    return fmt(total, code) + ' ' + code;
  }).join(' | ');
}

function renderTransfers() {
  const from = document.getElementById('transferFrom');
  const to = document.getElementById('transferTo');
  const selectedFrom = from.value;
  const selectedTo = to.value;
  const options = state.accounts.map(account => `<option value="${account.id}">${escapeHtml(account.name)} — ${account.currency} (${fmt(bal(account), account.currency)})</option>`).join('');
  from.innerHTML = options;
  to.innerHTML = options;
  if (state.accounts.some(account => account.id === selectedFrom)) from.value = selectedFrom;
  if (state.accounts.some(account => account.id === selectedTo)) to.value = selectedTo;
  if (!selectedTo && state.accounts.length > 1) to.value = state.accounts[1].id;

  const rows = [...state.transfers].sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  document.getElementById('transferList').innerHTML = rows.length ? '<h3>سجل التحويلات</h3>' + rows.map(transfer => {
    const source = state.accounts.find(account => account.id === transfer.from_account_id);
    const target = state.accounts.find(account => account.id === transfer.to_account_id);
    return `
      <div class="item">
        <div><b>${escapeHtml(source?.name || 'حساب محذوف')} ← ${escapeHtml(target?.name || 'حساب محذوف')}</b><br><small>${escapeHtml(transfer.occurred_on)} · ${escapeHtml(transfer.note || '')}</small></div>
        <div style="text-align:left"><strong class="amount">−${fmt(transfer.from_amount, source?.currency)} ${source?.currency || ''} / +${fmt(transfer.to_amount, target?.currency)} ${target?.currency || ''}</strong>
          <div class="controls"><button class="danger" onclick="deleteTransfer('${transfer.id}')">حذف التحويل</button></div>
        </div>
      </div>
    `;
  }).join('') : '<p class="muted">ماكو تحويلات مسجلة بعد.</p>';
}

function renderStats() {
  const monthInput = document.getElementById('statsMonth');
  if (!monthInput.value) monthInput.value = thisMonth();
  const stats = FuloosiCore.monthStats(state, monthInput.value);
  const remainingClass = stats.total_remaining_jod < 0 ? 'negative' : 'good';
  document.getElementById('budgetSummary').innerHTML = `
    <div class="tile"><small>مصروف الشهر</small><strong>${fmt(stats.total_spent_jod)} JOD</strong></div>
    <div class="tile"><small>الميزانية الشهرية</small><strong>${fmt(stats.total_budget_jod)} JOD</strong></div>
    <div class="tile"><small>المتبقي الكلي</small><strong class="${remainingClass}">${fmt(stats.total_remaining_jod)} JOD</strong></div>
  `;

  document.getElementById('categoryStats').innerHTML = stats.rows.length ? stats.rows.map(row => {
    const percentage = row.limit_jod > 0 ? Math.min(100, row.spent_jod / row.limit_jod * 100) : 0;
    const over = row.remaining_jod != null && row.remaining_jod < 0;
    return `
      <div class="stat-card">
        <div class="bar"><b>${escapeHtml(row.category)}</b><span class="amount">${fmt(row.spent_jod)} JOD</span></div>
        ${row.limit_jod > 0
          ? `<small>الحد ${fmt(row.limit_jod)} · المتبقي <span class="${over ? 'negative' : 'good'}">${fmt(row.remaining_jod)} JOD</span></small><div class="progress ${over ? 'over' : ''}"><span style="width:${percentage}%"></span></div>`
          : '<small>ما محدد إله حد شهري بعد</small>'}
      </div>
    `;
  }).join('') : '<p class="muted">ماكو تصنيفات بعد.</p>';

  document.getElementById('budgetList').innerHTML = state.budgets.map(budget => `
    <div class="item">
      <div><b>${escapeHtml(budget.category)}</b><br><small>حد شهري</small></div>
      <div style="text-align:left"><strong class="amount">${fmt(budget.monthly_limit_jod)} JOD</strong>
        <div class="controls">
          <button onclick="showBudgetForm(decodeURIComponent('${enc(budget.category)}'))">تعديل</button>
          <button class="danger" onclick="deleteBudget(decodeURIComponent('${enc(budget.category)}'))">حذف</button>
        </div>
      </div>
    </div>
  `).join('') || '<p class="muted">أضف أول تصنيف وميزانيته.</p>';
}

function renderDebts() {
  const totals = FuloosiCore.debtNet(null, state.debt_entries);
  document.getElementById('debtSummary').innerHTML = CURRENCIES.map(currency => `
    <div class="tile"><small>صافي الديون ${currency}</small><strong class="${totals[currency] < 0 ? 'negative' : 'good'}">${fmt(totals[currency], currency)}</strong>${totals[currency] ? `<small>${totals[currency] > 0 ? 'إلك' : 'عليك'}</small>` : ''}</div>
  `).join('');

  document.getElementById('personList').innerHTML = state.debt_people.length ? state.debt_people.map(person => {
    const net = FuloosiCore.debtNet(person.id, state.debt_entries);
    return `
      <div class="item">
        <div><b>${escapeHtml(person.name)}</b><div class="debt-chips">${CURRENCIES.filter(currency => net[currency]).map(currency => `<span class="chip ${net[currency] < 0 ? 'negative' : 'good'}">${net[currency] >= 0 ? 'إلك' : 'عليك'} ${fmt(Math.abs(net[currency]), currency)} ${currency}</span>`).join('') || '<span class="chip">ماكو دين مفتوح</span>'}</div></div>
        <div class="controls">
          ${CURRENCIES.filter(currency => net[currency]).map(currency => `<button class="primary" onclick="showSettlementForm('${person.id}', '${currency}')">تسديد ${currency}</button>`).join('')}
          <button onclick="showPersonForm('${person.id}')">تعديل الاسم</button><button class="danger" onclick="deletePerson('${person.id}')">حذف</button>
        </div>
      </div>
    `;
  }).join('') : '<p class="muted">أضف أسماء الشباب حتى تسجل الديون.</p>';

  const personSelect = document.getElementById('debtPerson');
  const selected = personSelect.value;
  personSelect.innerHTML = state.debt_people.map(person => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join('');
  if (state.debt_people.some(person => person.id === selected)) personSelect.value = selected;

  const rows = [...state.debt_entries].sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  document.getElementById('debtList').innerHTML = rows.length ? '<h3>الحركات</h3>' + rows.map(entry => {
    const person = state.debt_people.find(row => row.id === entry.person_id);
    const account = state.accounts.find(row => row.id === entry.settlement_account_id);
    const settled = Boolean(entry.settlement_account_id);
    const owedToMe = entry.direction === 'owed_to_me';
    const title = settled
      ? (owedToMe ? 'دفعت تسديد دين' : 'استلمت تسديد دين')
      : (owedToMe ? 'هو مدين إلي' : 'أنا مدين إله');
    const details = [title, account?.name, entry.occurred_on, entry.note].filter(Boolean).map(escapeHtml).join(' · ');
    return `
      <div class="item">
        <div><b>${escapeHtml(person?.name || 'اسم محذوف')}</b><br><small>${details}</small></div>
        <div style="text-align:left"><strong class="amount ${owedToMe ? 'good' : 'negative'}">${owedToMe ? '+' : '−'}${fmt(entry.amount, entry.currency)} ${entry.currency}</strong>
          <div class="controls">${settled ? '' : `<button onclick="editDebtEntry('${entry.id}')">تعديل</button>`}<button class="danger" onclick="deleteDebtEntry('${entry.id}')">${settled ? 'حذف التسديد' : 'حذف'}</button></div>
        </div>
      </div>
    `;
  }).join('') : '<p class="muted">ماكو حركات ديون بعد.</p>';
}

function tab(id) {
  ['accounts', 'add', 'transfers', 'stats', 'debts', 'entries', 'settings'].forEach(section => document.getElementById(section).classList.toggle('hide', section !== id));
  window.scrollTo({ top: 280, behavior: 'smooth' });
}

function requireCloud() {
  if (!cloudReady || !currentUser) throw Error('انتظر نجاح المزامنة قبل الحفظ');
}

async function insertRow(table, object) {
  if (cloud) {
    requireCloud();
    if (loading) await loading;
    requireCloud();
    const result = await client.from(table).insert({ ...object, user_id: currentUser.id }).select('*');
    if (result.error) throw result.error;
    if (result.data.length !== 1) throw Error('تعذر حفظ السجل');
  } else {
    localMutation(next => next[table].push(object));
  }
}

async function updateRow(table, id, object, revision) {
  if (cloud) {
    requireCloud();
    if (loading) await loading;
    requireCloud();
    const result = await client.from(table).update(object).eq('id', id).eq('revision', revision).select('id');
    if (result.error) throw result.error;
    if (result.data.length !== 1) throw Error('تغير السجل من جهاز آخر أو حُذف. حدّث البيانات وراجع التعديل.');
  } else {
    localMutation(next => {
      const index = next[table].findIndex(row => row.id === id);
      if (index < 0) throw Error('السجل غير موجود');
      next[table][index] = object;
    });
  }
}

async function removeRow(table, id, revision) {
  if (cloud) {
    requireCloud();
    if (loading) await loading;
    requireCloud();
    const result = await client.from(table).delete().eq('id', id).eq('revision', revision).select('id');
    if (result.error) throw result.error;
    if (result.data.length !== 1) throw Error('تغير السجل من جهاز آخر؛ حدّث البيانات أولاً.');
  } else {
    localMutation(next => { next[table] = next[table].filter(row => row.id !== id); });
  }
}

function showAccountForm(id) {
  hideBalanceForm();
  accountEditId = id || null;
  const account = state.accounts.find(row => row.id === id);
  const hasActivity = Boolean(account && (state.entries.some(entry => entry.account_id === id)
    || state.transfers.some(transfer => transfer.from_account_id === id || transfer.to_account_id === id)
    || state.debt_entries.some(debt => debt.settlement_account_id === id)));
  accountRevision = account?.revision ?? null;
  document.getElementById('accountForm').classList.remove('hide');
  document.getElementById('accountFormTitle').textContent = account ? 'تعديل حساب' : 'إضافة حساب';
  document.getElementById('aname').value = account?.name || '';
  document.getElementById('acurrency').value = account?.currency || 'IQD';
  document.getElementById('abalance').value = account?.opening_balance ?? 0;
  document.getElementById('acurrency').disabled = hasActivity;
  document.getElementById('abalance').disabled = hasActivity;
  document.getElementById('openingBalanceField').classList.toggle('hide', hasActivity);
  document.getElementById('editBalanceAction').classList.toggle('hide', !account);
  if (account) document.getElementById('editCurrentBalance').textContent = `${fmt(bal(account), account.currency)} ${account.currency}`;
  document.getElementById('accountForm').scrollIntoView?.({ behavior: 'smooth', block: 'center' });
}

function hideAccountForm() {
  document.getElementById('accountForm').classList.add('hide');
  document.getElementById('acurrency').disabled = false;
  document.getElementById('abalance').disabled = false;
  accountEditId = null;
  accountRevision = null;
}

function showBalanceForm(id = accountEditId) {
  if (busy) return;
  const account = state.accounts.find(row => row.id === id);
  if (!account) return;
  hideAccountForm();
  const current = bal(account);
  balanceDraft = { id, currency: account.currency, current };
  document.getElementById('balanceAccount').textContent = `${account.name} · الرصيد الحالي ${fmt(current, account.currency)} ${account.currency}`;
  document.getElementById('newBalance').value = current;
  const form = document.getElementById('balanceForm');
  form.classList.remove('hide');
  form.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  document.getElementById('newBalance').focus?.({ preventScroll: true });
  document.getElementById('newBalance').select?.();
}

function hideBalanceForm() {
  document.getElementById('balanceForm').classList.add('hide');
  document.getElementById('newBalance').value = '';
  balanceDraft = null;
}

async function saveAccountBalance() {
  const draft = balanceDraft;
  if (!draft) return;
  const target = FuloosiCore.money(document.getElementById('newBalance').value);
  if (cloud) await reload();
  const account = state.accounts.find(row => row.id === draft.id);
  if (balanceDraft !== draft) return;
  if (!account || account.currency !== draft.currency) {
    hideBalanceForm();
    throw Error('تغيّر الحساب. افتح الرصيد من القائمة مرة ثانية.');
  }
  const current = bal(account);
  if (current !== draft.current) {
    draft.current = current;
    document.getElementById('balanceAccount').textContent = `${account.name} · الرصيد الحالي ${fmt(current, account.currency)} ${account.currency}`;
    throw Error('تغيّر الرصيد بعد فتح التعديل. راجع الرصيد الحالي واضغط حفظ مرة ثانية إذا تريد تكمل.');
  }
  const difference = target - Math.round(current * 1000);
  if (difference) {
    const amount = Math.abs(difference) / 1000;
    FuloosiCore.money(amount);
    await insertRow('entries', {
      id: uid(), account_id: account.id, kind: difference < 0 ? 'expense' : 'adjustment', amount,
      category: FuloosiCore.balanceAdjustmentCategory, note: '', occurred_on: today(), created_at: new Date().toISOString()
    });
  }
  hideBalanceForm();
  if (difference) await reload({ fresh: true });
}

async function saveAccount() {
  const name = document.getElementById('aname').value.trim();
  const currency = document.getElementById('acurrency').value;
  const opening_balance = Number(document.getElementById('abalance').value);
  if (!name || !Number.isFinite(opening_balance) || Math.abs(opening_balance) > 1e12) throw Error('أدخل اسم ورصيد صحيح');
  const duplicateMessage = `هذا الاسم موجود بحساب عملته ${currency}`;
  if (!cloud && state.accounts.some(account => account.name === name && account.currency === currency && account.id !== accountEditId)) throw Error(duplicateMessage);
  const object = { id: accountEditId || uid(), name, currency, opening_balance };
  try {
    if (accountEditId) await updateRow('accounts', accountEditId, object, accountRevision);
    else await insertRow('accounts', object);
  } catch (error) {
    if (error.code === '23505') throw Error(duplicateMessage);
    throw error;
  }
  hideAccountForm();
  await reload({ fresh: true });
}

async function deleteAccount(id) {
  if (state.debt_entries.some(debt => debt.settlement_account_id === id)) throw Error('الحساب مرتبط بتسديد دين. احذف التسديد أولاً.');
  if (state.entries.some(entry => entry.account_id === id)) throw Error('الحساب يحتوي عمليات. احذف العمليات المرتبطة أولاً.');
  if (state.transfers.some(transfer => transfer.from_account_id === id || transfer.to_account_id === id)) throw Error('الحساب يحتوي تحويلات. احذف التحويلات المرتبطة أولاً.');
  if (!confirm('حذف الحساب نهائياً؟')) return;
  const account = state.accounts.find(row => row.id === id);
  if (!account) return;
  await removeRow('accounts', id, account.revision);
  await reload({ fresh: true });
}

async function saveEntry() {
  const account_id = document.getElementById('entryAccount').value;
  const amount = Number(document.getElementById('amount').value);
  const selectedKind = document.getElementById('kind').value;
  const isDecrease = selectedKind === 'adjustment_decrease';
  const kind = isDecrease ? 'expense' : selectedKind;
  const selectedCategory = document.getElementById('category').value;
  const category = isDecrease ? FuloosiCore.balanceAdjustmentCategory : selectedCategory;
  const note = document.getElementById('note').value.trim();
  const occurred_on = document.getElementById('date').value;
  if (!state.accounts.some(account => account.id === account_id) || !Number.isFinite(amount) || amount <= 0 || !occurred_on) throw Error('تأكد من الحساب والمبلغ والتاريخ');
  const object = { id: entryEditId || uid(), account_id, amount, kind, category, note, occurred_on, created_at: entryEditId ? entryDraft.created_at : new Date().toISOString() };
  if (entryEditId) await updateRow('entries', entryEditId, object, entryRevision);
  else await insertRow('entries', object);
  entryEditId = null;
  entryRevision = null;
  entryDraft = null;
  document.getElementById('amount').value = '';
  document.getElementById('note').value = '';
  await reload();
  tab('entries');
}

function editEntry(id) {
  const entry = state.entries.find(row => row.id === id);
  if (!entry) return;
  entryEditId = id;
  entryRevision = entry.revision ?? null;
  entryDraft = structuredClone(entry);
  tab('add');
  renderCategories();
  document.getElementById('entryAccount').value = entry.account_id;
  document.getElementById('kind').value = entry.kind === 'expense' && !FuloosiCore.isSpending(entry) ? 'adjustment_decrease' : entry.kind;
  document.getElementById('category').value = entry.category;
  document.getElementById('date').value = entry.occurred_on;
  document.getElementById('note').value = entry.note;
  document.getElementById('amount').value = entry.amount;
}

async function deleteEntry(id) {
  if (!confirm('تحذف العملية؟ راح يرجع تأثيرها من الرصيد.')) return;
  const entry = state.entries.find(row => row.id === id);
  await removeRow('entries', id, entry.revision);
  await reload();
}

function suggestTransferAmount() {
  const source = state.accounts.find(account => account.id === document.getElementById('transferFrom').value);
  const target = state.accounts.find(account => account.id === document.getElementById('transferTo').value);
  const amount = Number(document.getElementById('transferFromAmount').value);
  if (source && target && source.currency === target.currency && Number.isFinite(amount) && amount > 0) {
    document.getElementById('transferToAmount').value = amount;
  }
}

async function saveTransfer() {
  const from_account_id = document.getElementById('transferFrom').value;
  const to_account_id = document.getElementById('transferTo').value;
  const from_amount = Number(document.getElementById('transferFromAmount').value);
  const to_amount = Number(document.getElementById('transferToAmount').value);
  const occurred_on = document.getElementById('transferDate').value;
  const note = document.getElementById('transferNote').value.trim();
  if (!state.accounts.some(account => account.id === from_account_id) || !state.accounts.some(account => account.id === to_account_id)) throw Error('اختر حسابين صحيحين');
  if (from_account_id === to_account_id) throw Error('اختار حساب استلام غير حساب السحب');
  if (![from_amount, to_amount].every(amount => Number.isFinite(amount) && amount > 0) || !occurred_on) throw Error('تأكد من مبالغ التحويل والتاريخ');
  await insertRow('transfers', { id: uid(), from_account_id, to_account_id, from_amount, to_amount, occurred_on, note, created_at: new Date().toISOString() });
  document.getElementById('transferFromAmount').value = '';
  document.getElementById('transferToAmount').value = '';
  document.getElementById('transferNote').value = '';
  await reload();
  tab('transfers');
}

async function deleteTransfer(id) {
  if (!confirm('تحذف التحويل؟ راح يرجع المبلغان إلى أرصدة الحسابين.')) return;
  const transfer = state.transfers.find(row => row.id === id);
  await removeRow('transfers', id, transfer.revision);
  await reload();
}

function showBudgetForm(category) {
  budgetEditCategory = category || null;
  const budget = state.budgets.find(row => row.category === category);
  budgetRevision = budget?.revision ?? null;
  document.getElementById('budgetForm').classList.remove('hide');
  document.getElementById('budgetCategory').value = budget?.category || '';
  document.getElementById('budgetCategory').disabled = Boolean(budget);
  document.getElementById('budgetLimit').value = budget?.monthly_limit_jod ?? 0;
}

function hideBudgetForm() {
  document.getElementById('budgetForm').classList.add('hide');
  document.getElementById('budgetCategory').disabled = false;
  budgetEditCategory = null;
  budgetRevision = null;
}

async function saveBudget() {
  const category = document.getElementById('budgetCategory').value.trim();
  const monthly_limit_jod = Number(document.getElementById('budgetLimit').value);
  if (!category || category.length > 200 || !Number.isFinite(monthly_limit_jod) || monthly_limit_jod < 0 || monthly_limit_jod > 1e9) throw Error('أدخل تصنيف وحد شهري صحيح');
  if (!budgetEditCategory && state.budgets.some(row => row.category === category)) throw Error('هذا التصنيف موجود');
  if (cloud) {
    requireCloud();
    if (loading) await loading;
    requireCloud();
    const result = budgetEditCategory
      ? await client.from('budgets').update({ monthly_limit_jod }).eq('category', budgetEditCategory).eq('revision', budgetRevision).select('category')
      : await client.from('budgets').insert({ user_id: currentUser.id, category, monthly_limit_jod }).select('category');
    if (result.error) throw result.error;
    if (result.data.length !== 1) throw Error('تغيرت الميزانية من جهاز آخر؛ حدّث البيانات');
  } else {
    localMutation(next => {
      const index = next.budgets.findIndex(row => row.category === budgetEditCategory);
      if (index >= 0) next.budgets[index].monthly_limit_jod = monthly_limit_jod;
      else next.budgets.push({ category, monthly_limit_jod });
    });
  }
  hideBudgetForm();
  await reload();
  tab('stats');
}

async function deleteBudget(category) {
  if (!confirm('تحذف حد هذا التصنيف؟ المصاريف المسجلة تبقى محفوظة.')) return;
  const budget = state.budgets.find(row => row.category === category);
  if (cloud) {
    requireCloud();
    const result = await client.from('budgets').delete().eq('category', category).eq('revision', budget.revision).select('category');
    if (result.error) throw result.error;
    if (result.data.length !== 1) throw Error('تغيرت الميزانية من جهاز آخر؛ حدّث البيانات');
  } else {
    localMutation(next => { next.budgets = next.budgets.filter(row => row.category !== category); });
  }
  await reload();
}

function showPersonForm(id) {
  personEditId = id || null;
  const person = state.debt_people.find(row => row.id === id);
  personRevision = person?.revision ?? null;
  const form = document.getElementById('personForm');
  form.classList.remove('hide');
  document.getElementById('personFormTitle').textContent = person ? 'تعديل الاسم' : 'إضافة شخص';
  document.getElementById('personName').value = person?.name || '';
  form.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
}

function hidePersonForm() {
  document.getElementById('personForm').classList.add('hide');
  personEditId = null;
  personRevision = null;
}

async function savePerson() {
  const name = document.getElementById('personName').value.trim();
  if (!name || name.length > 100) throw Error('أدخل اسم صحيح');
  if (!cloud && state.debt_people.some(person => person.name === name && person.id !== personEditId)) throw Error('هذا الاسم موجود');
  const existing = state.debt_people.find(person => person.id === personEditId);
  if (personEditId && !existing) throw Error('انحذف هذا الاسم. حدّث قائمة الأسماء.');
  const object = { id: personEditId || uid(), name, created_at: existing?.created_at ?? new Date().toISOString() };
  try {
    if (personEditId) await updateRow('debt_people', personEditId, object, personRevision);
    else await insertRow('debt_people', object);
  } catch (error) {
    if (error.code === '23505') throw Error('هذا الاسم موجود');
    throw error;
  }
  hidePersonForm();
  await reload({ fresh: true });
  document.getElementById('debtPerson').value = object.id;
}

async function deletePerson(id) {
  if (state.debt_entries.some(entry => entry.person_id === id)) throw Error('هذا الشخص عنده حركات ديون. احذف حركاته أولاً.');
  if (!confirm('تحذف الاسم من سجل الديون؟')) return;
  const person = state.debt_people.find(row => row.id === id);
  if (!person) return;
  await removeRow('debt_people', id, person.revision);
  if (personEditId === id) hidePersonForm();
  await reload({ fresh: true });
}

async function saveDebtEntry() {
  const person_id = document.getElementById('debtPerson').value;
  const direction = document.getElementById('debtDirection').value;
  const amount = FuloosiCore.money(document.getElementById('debtAmount').value) / 1000;
  const currency = document.getElementById('debtCurrency').value;
  const occurred_on = document.getElementById('debtDate').value;
  const note = document.getElementById('debtNote').value.trim();
  if (!state.debt_people.some(person => person.id === person_id)) throw Error('أضف اسم الشخص أولاً');
  if (amount <= 0 || !occurred_on) throw Error('تأكد من المبلغ والتاريخ');
  const object = { id: debtEditId || uid(), person_id, direction, amount, currency, occurred_on, note, created_at: debtEditId ? debtDraft.created_at : new Date().toISOString() };
  if (debtEditId) await updateRow('debt_entries', debtEditId, object, debtRevision);
  else await insertRow('debt_entries', object);
  cancelDebtEdit();
  await reload({ fresh: true });
}

function editDebtEntry(id) {
  const entry = state.debt_entries.find(row => row.id === id);
  if (!entry || entry.settlement_account_id) return;
  debtEditId = id;
  debtRevision = entry.revision ?? null;
  debtDraft = structuredClone(entry);
  document.getElementById('debtFormTitle').textContent = 'تعديل الدين';
  document.getElementById('cancelDebtEdit').classList.remove('hide');
  document.getElementById('debtPerson').value = entry.person_id;
  document.getElementById('debtDirection').value = entry.direction;
  document.getElementById('debtAmount').value = entry.amount;
  document.getElementById('debtCurrency').value = entry.currency;
  document.getElementById('debtDate').value = entry.occurred_on;
  document.getElementById('debtNote').value = entry.note;
  document.getElementById('debtFormTitle').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

function cancelDebtEdit() {
  debtEditId = null;
  debtRevision = null;
  debtDraft = null;
  document.getElementById('debtFormTitle').textContent = 'إضافة دين';
  document.getElementById('cancelDebtEdit').classList.add('hide');
  document.getElementById('debtAmount').value = '';
  document.getElementById('debtNote').value = '';
  document.getElementById('debtDate').value = today();
}

function showSettlementForm(personId, currency) {
  const person = state.debt_people.find(row => row.id === personId);
  const net = FuloosiCore.debtNet(personId, state.debt_entries)[currency];
  if (!person || !net) return;
  const accounts = state.accounts.filter(account => account.currency === currency);
  if (!accounts.length) {
    alert(`أضف حساب بعملة ${currency} حتى تسجّل التسديد.`);
    return;
  }
  const received = net > 0;
  settlementDraft = { id: uid(), personId, currency, direction: received ? 'i_owe' : 'owed_to_me' };
  document.getElementById('settlementTitle').textContent = received ? 'استلام تسديد من ' + person.name : 'دفع تسديد إلى ' + person.name;
  document.getElementById('settlementDetails').textContent = `المبلغ المتبقي: ${fmt(Math.abs(net), currency)} ${currency}`;
  document.getElementById('settlementAccountLabel').textContent = received ? 'أضف المبلغ إلى حساب' : 'اخصم المبلغ من حساب';
  const accountSelect = document.getElementById('settlementAccount');
  accountSelect.innerHTML = accounts.map(account => `<option value="${account.id}">${escapeHtml(account.name)}</option>`).join('');
  accountSelect.value = accounts[0].id;
  document.getElementById('settlementAmount').value = Math.min(Math.abs(net), 1e12);
  document.getElementById('settlementDate').value = today();
  const form = document.getElementById('settlementForm');
  form.classList.remove('hide');
  form.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
}

function hideSettlementForm() {
  settlementDraft = null;
  document.getElementById('settlementForm').classList.add('hide');
}

async function saveDebtSettlement() {
  const draft = settlementDraft;
  if (!draft) return;
  const accountId = document.getElementById('settlementAccount').value;
  const account = state.accounts.find(row => row.id === accountId);
  const amount = FuloosiCore.money(document.getElementById('settlementAmount').value) / 1000;
  const occurredOn = document.getElementById('settlementDate').value;
  if (!account || account.currency !== draft.currency) throw Error('اختار حساب بنفس عملة الدين.');
  if (amount <= 0 || !occurredOn) throw Error('تأكد من مبلغ التسديد والتاريخ.');
  if (cloud) {
    requireCloud();
    if (loading) await loading;
    if (draft !== settlementDraft) return;
    requireCloud();
    const { error } = await client.rpc('fuloosi_settle_debt', {
      p_id: draft.id, p_person_id: draft.personId, p_account_id: accountId,
      p_currency: draft.currency, p_direction: draft.direction, p_amount: amount, p_occurred_on: occurredOn
    });
    if (error) throw error;
  } else {
    const net = FuloosiCore.debtNet(draft.personId, state.debt_entries)[draft.currency];
    if ((draft.direction === 'i_owe' ? net : -net) < amount) throw Error('مبلغ التسديد أكبر من الرصيد المتبقي أو اتجاه الدين تغيّر.');
    await insertRow('debt_entries', {
      id: draft.id, person_id: draft.personId, settlement_account_id: accountId, direction: draft.direction,
      amount, currency: draft.currency, occurred_on: occurredOn, note: '', created_at: new Date().toISOString()
    });
  }
  if (draft !== settlementDraft) return;
  hideSettlementForm();
  await reload({ fresh: true });
}

async function deleteDebtEntry(id) {
  const entry = state.debt_entries.find(row => row.id === id);
  if (!entry) return;
  if (!confirm(entry.settlement_account_id ? 'تحذف التسديد وترجع المبلغ إلى رصيد الدين والحساب قبل الدفعة؟' : 'تحذف حركة الدين؟')) return;
  await removeRow('debt_entries', id, entry.revision);
  if (debtEditId === id) cancelDebtEdit();
  await reload({ fresh: true });
}

async function saveSettings() {
  const iqd_per_usd = Number(document.getElementById('iqdRate').value);
  const jod_per_usd = Number(document.getElementById('jodRate').value);
  const monthly_budget_jod = Number(document.getElementById('monthlyBudget').value);
  if (![iqd_per_usd, jod_per_usd].every(value => Number.isFinite(value) && value > 0 && value <= 1e9) || !Number.isFinite(monthly_budget_jod) || monthly_budget_jod < 0 || monthly_budget_jod > 1e9) throw Error('الإعدادات المالية غير صالحة');
  if (cloud) {
    requireCloud();
    if (loading) await loading;
    requireCloud();
    const row = { user_id: currentUser.id, iqd_per_usd, jod_per_usd, monthly_budget_jod };
    const revision = settingsDirty ? settingsRevision : state.settings.revision;
    const result = revision
      ? await client.from('settings').update(row).eq('user_id', currentUser.id).eq('revision', revision).select('user_id')
      : await client.from('settings').insert(row).select('user_id');
    if (result.error) throw result.error;
    if (result.data.length !== 1) throw Error('تغيرت الإعدادات من جهاز آخر؛ حدّث البيانات');
  } else {
    localMutation(next => { next.settings = { iqd_per_usd, jod_per_usd, monthly_budget_jod }; });
  }
  settingsDirty = false;
  settingsRevision = null;
  await reload();
  msg('تم حفظ الإعدادات والميزانية الشهرية');
}

const reportFormats = {
  xlsx: { library: 'ExcelJS', script: 'exceljs-4.4.0.min.js', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel' },
  pdf: { library: 'PDFLib', script: 'pdf-lib-1.17.1.min.js', mime: 'application/pdf', label: 'PDF' }
};

function updateReportPeriod() {
  const isMonth = document.getElementById('reportPeriod').value === 'month';
  document.getElementById('reportMonthField').classList.toggle('hide', !isMonth);
  const input = document.getElementById('reportMonth');
  if (isMonth && !input.value) input.value = thisMonth();
}

function clearReportDownload() {
  if (reportUrl) {
    URL.revokeObjectURL(reportUrl);
    reportUrl = null;
    document.getElementById('reportDownload').removeAttribute('href');
  }
  document.getElementById('reportDownloadBox').classList.add('hide');
}

async function loadReportLibrary(format) {
  if (window[format.library]) return window[format.library];
  const script = document.createElement('script');
  script.src = format.script;
  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(Error(`تعذر تحميل أداة ${format.label}. جرّب مرة ثانية.`));
    document.head.appendChild(script);
  }).finally(() => script.remove());
  if (!window[format.library]) throw Error('تعذر تجهيز التصدير.');
  return window[format.library];
}

async function exportReport(extension) {
  const format = reportFormats[extension];
  if (!format) throw Error('صيغة التصدير غير متاحة.');
  const month = document.getElementById('reportPeriod').value === 'month' ? document.getElementById('reportMonth').value : '';
  if (!month && document.getElementById('reportPeriod').value === 'month') throw Error('اختار الشهر أولاً.');
  const status = document.getElementById('reportStatus');
  clearReportDownload();
  status.textContent = `جاري تجهيز ${format.label}…`;
  const version = epoch;
  try {
    if (cloud || needsLogin()) {
      if (!currentUser) throw Error('سجّل الدخول حتى تصدّر بياناتك.');
      await reload({ fresh: true });
      if (version !== epoch) return;
      requireCloud();
    } else if (storageBroken) {
      throw Error('تعذر قراءة البيانات المحلية.');
    }
    const report = FuloosiReports.build(state, month, today());
    const library = await loadReportLibrary(format);
    if (version !== epoch) return;
    const bytes = extension === 'xlsx'
      ? await FuloosiReports.excel(report, library)
      : await FuloosiReports.pdf(report, library, document);
    if (version !== epoch) return;
    reportUrl = URL.createObjectURL(new Blob([bytes], { type: format.mime }));
    const link = document.getElementById('reportDownload');
    link.href = reportUrl;
    link.download = `fuloosi-${month || 'all'}-${report.stamp}.${extension}`;
    link.textContent = `تنزيل ${format.label}`;
    document.getElementById('reportDownloadBox').classList.remove('hide');
    status.textContent = `ملف ${format.label} جاهز.`;
    link.click();
  } catch (error) {
    if (version !== epoch) return;
    status.textContent = error.message;
    throw error;
  }
}

function exportData() {
  const blob = new Blob([JSON.stringify({ format: 'fuloosi-v4', exported_at: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'fuloosi-backup-' + today() + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function importData(input) {
  try {
    if (cloud) throw Error('الاستيراد متاح محلياً فقط. رفع السحابة يضيف السجلات دون استبدالها.');
    const file = input.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) throw Error('الملف أكبر من 10 MB');
    const next = FuloosiCore.validate(JSON.parse(await file.text()));
    if (!confirm('هذا سيستبدل بيانات فلوسي المحلية فقط. هل توافق؟ ستُحفظ النسخة السابقة تلقائياً.')) return;
    if (storageBroken) throw Error('يوجد خطأ في البيانات الحالية؛ لن نستبدلها');
    localStorage.setItem('fuloosi-before-import-' + Date.now(), JSON.stringify(local));
    localMutation(target => Object.assign(target, next));
    render();
    msg('تم الاستيراد وحفظ نسخة من البيانات السابقة');
  } finally {
    input.value = '';
  }
}

function msg(text) {
  document.getElementById('message').textContent = text;
}

function clearForms() {
  settingsDirty = false;
  settingsRevision = null;
  accountEditId = null;
  entryEditId = null;
  budgetEditCategory = null;
  personEditId = null;
  debtEditId = null;
  hideAccountForm();
  hideBalanceForm();
  hideBudgetForm();
  hidePersonForm();
  hideSettlementForm();
  clearReportDownload();
  document.getElementById('reportStatus').textContent = '';
  cancelDebtEdit();
  ['amount', 'note', 'password', 'aname', 'abalance', 'personName', 'budgetCategory', 'budgetLimit'].forEach(id => { document.getElementById(id).value = ''; });
}

function snapshotState(data) {
  return {
    accounts: data?.accounts || [],
    entries: data?.entries || [],
    transfers: data?.transfers || [],
    budgets: data?.budgets || [],
    debt_people: data?.debt_people || [],
    debt_entries: data?.debt_entries || [],
    settings: data?.settings || initial().settings
  };
}

async function activate(session) {
  const id = session?.user?.id || null;
  if (id === currentUser?.id && cloud === Boolean(session)) {
    if (session) await reload();
    return;
  }
  epoch++;
  loading = null;
  currentUser = session?.user || null;
  cloud = Boolean(session);
  cloudReady = false;
  clearForms();
  state = cloud || needsLogin() ? initial() : local;
  render();
  document.getElementById('status').textContent = cloud ? 'جارٍ تحميل بيانات حسابك' : needsLogin() ? 'سجل الدخول لحفظ بياناتك' : 'محلي على هذا الجهاز';
  document.getElementById('localWarn').classList.toggle('hide', cloud);
  await reload();
}

async function connectCloud() {
  const url = document.getElementById('sbUrl').value.trim();
  const key = document.getElementById('sbKey').value.trim();
  if (!FuloosiCore.validConfig(url, key)) throw Error('أدخل رابط Supabase ومفتاح publishable أو anon فقط');
  if (!window.supabase) throw Error('تعذر تحميل مكتبة الاتصال؛ تحقق من الإنترنت');
  if (client) {
    if (url !== client.supabaseUrl.replace(/\/$/, '')) throw Error('المشروع مرتبط بالفعل؛ حدّث الصفحة قبل تغييره');
    return;
  }
  localStorage.setItem('fuloosi-cloud-config', JSON.stringify({ url, key }));
  client = window.supabase.createClient(url, key, {
    auth: { storageKey: 'fuloosi-auth-' + new URL(url).hostname, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
  });
  document.getElementById('authBox').classList.remove('hide');
  authSubscription = client.auth.onAuthStateChange((event, session) => {
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') document.getElementById('recoverButton').classList.remove('hide');
      activate(session).catch(error => msg(error.message));
    }, 0);
  }).data.subscription;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  await activate(data.session);
  msg(data.session ? 'تم الاتصال بحسابك' : 'سجل الدخول أو أنشئ حساباً');
}

const credentials = () => ({ email: document.getElementById('email').value.trim(), password: document.getElementById('password').value });

async function signUp() {
  if (!client) throw Error('اربط المشروع أولاً');
  const values = credentials();
  if (values.password.length < 12) throw Error('استخدم كلمة مرور لا تقل عن 12 حرفاً');
  const { data, error } = await client.auth.signUp({ ...values, options: { emailRedirectTo: location.origin + location.pathname } });
  document.getElementById('password').value = '';
  if (error) throw error;
  if (data.session) await activate(data.session);
  msg('راجع بريدك لتأكيد الحساب ثم سجل الدخول.');
}

async function signIn() {
  if (!client) throw Error('اربط المشروع أولاً');
  const { data, error } = await client.auth.signInWithPassword(credentials());
  document.getElementById('password').value = '';
  if (error) throw error;
  await activate(data.session);
  msg('تم تسجيل الدخول');
}

async function signOut() {
  if (client) {
    const { error } = await client.auth.signOut();
    if (error) throw error;
  }
  await activate(null);
  document.getElementById('recoverButton').classList.add('hide');
  msg('تم تسجيل الخروج');
}

async function resetPassword() {
  if (!client) throw Error('اربط المشروع أولاً');
  const { error } = await client.auth.resetPasswordForEmail(credentials().email, { redirectTo: location.origin + location.pathname });
  if (error) throw error;
  msg('إذا كان البريد مسجلاً، سيصله رابط استعادة كلمة المرور. افتح الرابط في نفس المتصفح.');
}

async function updatePassword() {
  const password = credentials().password;
  if (password.length < 12) throw Error('استخدم 12 حرفاً على الأقل');
  const { error } = await client.auth.updateUser({ password });
  document.getElementById('password').value = '';
  if (error) throw error;
  document.getElementById('recoverButton').classList.add('hide');
  msg('تم تغيير كلمة المرور');
}

async function reload({ fresh = false } = {}) {
  if (!cloud) {
    state = needsLogin() ? initial() : local;
    render();
    return;
  }
  if (loading && !fresh) return loading;
  const version = epoch;
  const who = currentUser.id;
  const task = (async () => {
    const { data, error } = await client.rpc('fuloosi_snapshot');
    if (loading !== task || version !== epoch || who !== currentUser?.id) return;
    if (error) {
      cloudReady = false;
      document.getElementById('status').textContent = '⚠️ تعذرت المزامنة';
      document.getElementById('syncInfo').textContent = 'لم تنجح المزامنة؛ البيانات المعروضة قديمة';
      throw error;
    }
    state = snapshotState(data);
    cloudReady = true;
    document.getElementById('status').textContent = '☁️ ' + currentUser.email;
    document.getElementById('syncInfo').textContent = 'آخر مزامنة: ' + new Date().toLocaleTimeString('ar-JO');
    render();
  })();
  loading = task;
  try { await task; } finally { if (loading === task) loading = null; }
}

async function syncNow() {
  await reload();
  if (!cloud) msg('تستخدم التخزين المحلي؛ سجل الدخول للمزامنة بين الأجهزة');
}

async function migrateLocal() {
  if (!cloud) throw Error('سجل دخول أولاً');
  requireCloud();
  const payload = FuloosiCore.validate(local);
  if (!confirm('إضافة بيانات النسخة المحلية إلى حسابك؟ لن نستبدل أي سجل أو إعداد موجود.')) return;
  const { data, error } = await client.rpc('fuloosi_import_missing', { payload });
  if (error) throw error;
  await reload();
  msg('تمت إضافة السجلات الناقصة فقط. بياناتك المحلية محفوظة.');
}

const protectedActions = {
  saveAccount, saveAccountBalance, deleteAccount, saveEntry, deleteEntry, saveBudget, deleteBudget,
  saveTransfer, deleteTransfer, savePerson, deletePerson, saveDebtEntry, saveDebtSettlement, deleteDebtEntry, saveSettings,
  connectCloud, signUp, signIn, signOut, resetPassword, updatePassword, syncNow, migrateLocal, exportReport
};
for (const [name, original] of Object.entries(protectedActions)) {
  window[name] = (...args) => action(() => original(...args));
}

Object.assign(window, {
  tab,
  showAccountForm,
  hideAccountForm,
  showBalanceForm,
  hideBalanceForm,
  editEntry,
  renderEntries,
  renderStats,
  showBudgetForm,
  hideBudgetForm,
  showPersonForm,
  hidePersonForm,
  showSettlementForm,
  hideSettlementForm,
  editDebtEntry,
  cancelDebtEdit,
  suggestTransferAmount,
  updateReportPeriod,
  exportData,
  importData
});

for (const id of ['iqdRate', 'jodRate', 'monthlyBudget']) {
  document.getElementById(id).addEventListener('input', () => {
    if (needsLogin() && !cloudReady) return;
    if (!settingsDirty) {
      settingsRevision = state.settings.revision ?? null;
      settingsDirty = true;
    }
  });
}

window.addEventListener('online', () => { if (cloud) reload().catch(error => msg(error.message)); });
window.addEventListener('offline', () => {
  if (cloud) {
    cloudReady = false;
    document.getElementById('status').textContent = '⚠️ لا يوجد اتصال';
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && cloud) reload().catch(error => msg(error.message)); });
setInterval(() => { if (cloud && !document.hidden && !busy) reload().catch(error => msg(error.message)); }, 15000);

(async () => {
  document.getElementById('date').value = today();
  document.getElementById('transferDate').value = today();
  document.getElementById('debtDate').value = today();
  document.getElementById('statsMonth').value = thisMonth();
  render();
  if (needsLogin()) {
    tab('settings');
    document.getElementById('localWarn').textContent = 'سجل الدخول أو أنشئ حساباً حتى تنحفظ بياناتك وتتزامن بين أجهزتك.';
    document.getElementById('projectSetup').classList.add('hide');
  }
  try {
    const config = window.FULOOSI_CONFIG?.url ? window.FULOOSI_CONFIG : JSON.parse(localStorage.getItem('fuloosi-cloud-config') || 'null');
    if (config) {
      document.getElementById('sbUrl').value = config.url;
      document.getElementById('sbKey').value = config.key;
      await connectCloud();
    }
  } catch (error) {
    msg(error.message);
  }
})();
