const { test } = require('node:test');
const assert = require('node:assert/strict');
const reports = require('./reports.js');
const ExcelJS = require('./exceljs-4.4.0.min.js');

const today = '2026-11-11';
const state = {
  accounts: [
    { id: 'j', name: 'كاش أردني', currency: 'JOD', opening_balance: 100 },
    { id: 'u', name: 'كاش دولار', currency: 'USD', opening_balance: 20 }
  ],
  entries: [
    { account_id: 'j', kind: 'expense', amount: 10.125, category: 'أكل', note: '=1+2', occurred_on: '2026-11-01' },
    { account_id: 'j', kind: 'expense', amount: 2, category: 'تسوية رصيد', note: '', occurred_on: '2026-11-02' },
    { account_id: 'j', kind: 'expense', amount: 3, category: 'أكل', note: '', occurred_on: '2026-10-31' }
  ],
  transfers: [{ from_account_id: 'u', to_account_id: 'j', from_amount: 10, to_amount: 7.09, note: '', occurred_on: '2026-11-03' }],
  budgets: [{ category: 'أكل', monthly_limit_jod: 25 }],
  debt_people: [{ id: 'm', name: 'محمود' }],
  debt_entries: [
    { person_id: 'm', direction: 'owed_to_me', amount: 10, currency: 'JOD', note: '', occurred_on: '2026-10-10' },
    { person_id: 'm', direction: 'i_owe', amount: 4, currency: 'JOD', settlement_account_id: 'j', note: '', occurred_on: '2026-11-04' }
  ],
  settings: { iqd_per_usd: 1685, jod_per_usd: 0.709, monthly_budget_jod: 600 }
};
const rows = (report, name) => report.tables.find(table => table.name === name).rows;

test('month reports filter activity and calculate category spending with current balances', () => {
  const source = structuredClone(state);
  const report = reports.build(source, '2026-11', today);
  assert.deepEqual(source, state);
  assert.deepEqual(rows(report, 'ملخص المحفظة')[1], ['JOD', 95.965, 6, 101.965]);
  assert.deepEqual(rows(report, 'الحسابات')[0], ['كاش أردني', 'JOD', 100, 95.965]);
  assert.deepEqual(rows(report, 'الميزانية والمصاريف')[0], ['2026-11', 'الإجمالي', 600, 10.125, 589.875]);
  assert.deepEqual(rows(report, 'الميزانية والمصاريف')[1], ['2026-11', 'أكل', 25, 10.125, 14.875]);
  assert.deepEqual(rows(report, 'العمليات').map(row => row[0]), ['2026-11-02', '2026-11-01']);
  assert.deepEqual(rows(report, 'التحويلات')[0].slice(2, 7), [10, 'USD', 'كاش أردني', 7.09, 'JOD']);
  assert.deepEqual(rows(report, 'أرصدة الديون'), [['محمود', 'JOD', 6]]);
  assert.deepEqual(rows(report, 'حركات الديون'), [['2026-11-04', 'محمود', 'استلمت تسديد', -4, 'JOD', 'كاش أردني', '']]);
});

test('all history and empty months produce valid reports', () => {
  const report = reports.build(state, '', today);
  assert.equal(rows(report, 'العمليات').length, 3);
  assert.equal(rows(report, 'حركات الديون').length, 2);
  assert.deepEqual(rows(report, 'الميزانية والمصاريف').filter(row => row[1] === 'الإجمالي').map(row => [row[0], row[3]]), [
    ['2026-11', 10.125], ['2026-10', 3]
  ]);
  const empty = reports.build(state, '2026-09', today);
  assert.equal(rows(empty, 'العمليات').length, 0);
  assert.equal(rows(empty, 'حركات الديون').length, 0);
  assert.equal(rows(empty, 'الميزانية والمصاريف')[0][3], 0);
  assert.throws(() => reports.build(state, '2026-13', today), /اختار شهر صالح/);
});

test('Excel download reopens with seven RTL sheets, typed dates and numbers, and literal notes', async () => {
  const report = reports.build(state, '2026-11', today);
  const bytes = await reports.excel(report, ExcelJS);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), report.tables.map(table => table.name));
  const summary = workbook.getWorksheet('ملخص المحفظة');
  assert.match(summary.getCell('A2').value, /2026-11/);
  assert.equal(summary.getCell('D7').value, 101.965);
  const sheet = workbook.getWorksheet('العمليات');
  assert.equal(sheet.views[0].rightToLeft, true);
  assert.ok(sheet.autoFilter);
  assert.equal(sheet.getCell('A3').value.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(sheet.getCell('E3').value, -10.125);
  assert.equal(sheet.getCell('G3').value, '=1+2');
});
