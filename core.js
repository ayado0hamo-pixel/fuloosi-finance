'use strict';

(function (root) {
  const currencies = ['IQD', 'JOD', 'USD'];
  const directions = ['owed_to_me', 'i_owe'];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const balanceAdjustmentCategory = 'تسوية رصيد';

  // The existing ledger represents every debit with kind 'expense'.
  const isSpending = entry => entry.kind === 'expense' && entry.category !== balanceAdjustmentCategory;

  function money(value) {
    const n = Number(value);
    if (value == null || value === '' || !Number.isFinite(n) || Math.abs(n) > 1e12 || Math.abs(n * 1000 - Math.round(n * 1000)) > 0.001) {
      throw Error('المبلغ غير صالح؛ أقصى دقة ثلاث منازل عشرية');
    }
    return Math.round(n * 1000);
  }

  function defaultBudgets() {
    return [
      ['🍔 أكل وشرب', 0],
      ['🚗 مواصلات', 80],
      ['🛒 تسوق', 60],
      ['🏃🏻 طلعات', 0],
      ['📱 اشتراكات', 25],
      ['🏠 سكن', 210],
      ['🛍️ شوبنك', 0],
      ['💈 حلاقة', 33]
    ].map(([category, monthly_limit_jod]) => ({ category, monthly_limit_jod }));
  }

  function validate(x) {
    if (!x || !Array.isArray(x.accounts) || !Array.isArray(x.entries) || !x.settings) throw Error('نسخة احتياطية غير صالحة');
    const ids = new Set();
    const eids = new Set();
    const personIds = new Set();
    const debtIds = new Set();
    const transferIds = new Set();

    const accounts = x.accounts.map(a => {
      if (!uuid.test(a.id) || ids.has(a.id) || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 100 || !currencies.includes(a.currency)) throw Error('بيانات الحساب غير صالحة');
      ids.add(a.id);
      money(a.opening_balance);
      return { id: a.id, name: a.name.trim(), currency: a.currency, opening_balance: Number(a.opening_balance) };
    });
    if (new Set(accounts.map(a => a.currency + '\0' + a.name)).size !== accounts.length) throw Error('يوجد حساب مكرر');

    const entries = x.entries.map(e => {
      if (!uuid.test(e.id) || eids.has(e.id) || !ids.has(e.account_id) || !['expense', 'income', 'adjustment'].includes(e.kind) || money(e.amount) <= 0 || !validDate(e.occurred_on)) throw Error('بيانات العملية غير صالحة');
      if (typeof e.category !== 'string' || !e.category.trim() || e.category.length > 200 || typeof e.note !== 'string' || e.note.length > 2000) throw Error('الوصف غير صالح');
      eids.add(e.id);
      return { id: e.id, account_id: e.account_id, kind: e.kind, amount: Number(e.amount), category: e.category.trim(), note: e.note, occurred_on: e.occurred_on, created_at: e.created_at || new Date().toISOString() };
    });

    const budgetSource = Array.isArray(x.budgets) ? x.budgets : defaultBudgets();
    const budgets = budgetSource.map(b => {
      if (typeof b.category !== 'string' || !b.category.trim() || b.category.length > 200 || money(b.monthly_limit_jod) < 0) throw Error('بيانات الميزانية غير صالحة');
      return { category: b.category.trim(), monthly_limit_jod: Number(b.monthly_limit_jod) };
    });
    if (new Set(budgets.map(b => b.category)).size !== budgets.length) throw Error('يوجد تصنيف ميزانية مكرر');

    const debt_people = (Array.isArray(x.debt_people) ? x.debt_people : []).map(p => {
      if (!uuid.test(p.id) || personIds.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100) throw Error('بيانات شخص الدين غير صالحة');
      personIds.add(p.id);
      return { id: p.id, name: p.name.trim(), created_at: p.created_at || new Date().toISOString() };
    });
    if (new Set(debt_people.map(p => p.name)).size !== debt_people.length) throw Error('اسم شخص الدين مكرر');

    const debt_entries = (Array.isArray(x.debt_entries) ? x.debt_entries : []).map(d => {
      if (!uuid.test(d.id) || debtIds.has(d.id) || !personIds.has(d.person_id) || !directions.includes(d.direction) || !currencies.includes(d.currency) || money(d.amount) <= 0 || !validDate(d.occurred_on)) throw Error('بيانات الدين غير صالحة');
      if (typeof d.note !== 'string' || d.note.length > 2000) throw Error('ملاحظة الدين غير صالحة');
      debtIds.add(d.id);
      return { id: d.id, person_id: d.person_id, direction: d.direction, amount: Number(d.amount), currency: d.currency, note: d.note, occurred_on: d.occurred_on, created_at: d.created_at || new Date().toISOString() };
    });

    const transfers = (Array.isArray(x.transfers) ? x.transfers : []).map(t => {
      if (!uuid.test(t.id) || transferIds.has(t.id) || !ids.has(t.from_account_id) || !ids.has(t.to_account_id) || t.from_account_id === t.to_account_id || money(t.from_amount) <= 0 || money(t.to_amount) <= 0 || !validDate(t.occurred_on)) throw Error('بيانات التحويل غير صالحة');
      if (typeof t.note !== 'string' || t.note.length > 2000) throw Error('ملاحظة التحويل غير صالحة');
      transferIds.add(t.id);
      return { id: t.id, from_account_id: t.from_account_id, to_account_id: t.to_account_id, from_amount: Number(t.from_amount), to_amount: Number(t.to_amount), note: t.note, occurred_on: t.occurred_on, created_at: t.created_at || new Date().toISOString() };
    });

    const settings = {
      iqd_per_usd: Number(x.settings.iqd_per_usd),
      jod_per_usd: Number(x.settings.jod_per_usd),
      monthly_budget_jod: Number(x.settings.monthly_budget_jod ?? 600)
    };
    if (![settings.iqd_per_usd, settings.jod_per_usd].every(v => Number.isFinite(v) && v > 0 && v <= 1e9) || !Number.isFinite(settings.monthly_budget_jod) || settings.monthly_budget_jod < 0 || settings.monthly_budget_jod > 1e9) throw Error('الإعدادات المالية غير صالحة');

    return { accounts, entries, transfers, budgets, debt_people, debt_entries, settings };
  }

  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  }

  function balance(account, entries, transfers = []) {
    const entryEffect = entries.filter(e => e.account_id === account.id).reduce((sum, entry) => sum + (entry.kind === 'expense' ? -1 : 1) * money(entry.amount), 0);
    const transferEffect = transfers.reduce((sum, transfer) => {
      if (transfer.from_account_id === account.id) sum -= money(transfer.from_amount);
      if (transfer.to_account_id === account.id) sum += money(transfer.to_amount);
      return sum;
    }, 0);
    return (money(account.opening_balance) + entryEffect + transferEffect) / 1000;
  }

  function toJod(amount, currency, settings) {
    const n = Number(amount);
    if (!Number.isFinite(n) || !currencies.includes(currency)) throw Error('تعذر تحويل المبلغ');
    if (currency === 'JOD') return n;
    if (currency === 'USD') return n * Number(settings.jod_per_usd);
    return n / Number(settings.iqd_per_usd) * Number(settings.jod_per_usd);
  }

  function monthStats(state, month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw Error('الشهر غير صالح');
    const spent = {};
    for (const entry of state.entries) {
      if (!isSpending(entry) || !String(entry.occurred_on).startsWith(month + '-')) continue;
      const account = state.accounts.find(a => a.id === entry.account_id);
      if (!account) continue;
      spent[entry.category] = (spent[entry.category] || 0) + toJod(entry.amount, account.currency, state.settings);
    }
    const categories = new Set([...(state.budgets || []).map(b => b.category), ...Object.keys(spent)]);
    const rows = [...categories].map(category => {
      const limit = Number((state.budgets || []).find(b => b.category === category)?.monthly_limit_jod || 0);
      const used = spent[category] || 0;
      return { category, spent_jod: used, limit_jod: limit, remaining_jod: limit > 0 ? limit - used : null };
    });
    const total_spent_jod = rows.reduce((sum, row) => sum + row.spent_jod, 0);
    const total_budget_jod = Number(state.settings.monthly_budget_jod || 0);
    return { rows, total_spent_jod, total_budget_jod, total_remaining_jod: total_budget_jod - total_spent_jod };
  }

  function debtNet(personId, entries) {
    const result = Object.fromEntries(currencies.map(c => [c, 0]));
    for (const entry of entries) {
      if (personId !== null && entry.person_id !== personId) continue;
      result[entry.currency] += (entry.direction === 'owed_to_me' ? 1 : -1) * money(entry.amount);
    }
    for (const currency of currencies) result[currency] /= 1000;
    return result;
  }

  function validConfig(url, key) {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) return false;
    if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
    try { return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; } catch { return false; }
  }

  const api = { money, validate, balance, toJod, monthStats, debtNet, defaultBudgets, validConfig, balanceAdjustmentCategory, isSpending };
  root.FuloosiCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
