'use strict';

(function (root) {
  const core = typeof module === 'undefined' ? root.FuloosiCore : require('./core.js');
  const currencies = ['IQD', 'JOD', 'USD'];
  const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
  const reportFont = '"DejaVu Sans", Arial, "Noto Sans Arabic", sans-serif';
  const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
  const dateColumn = ['التاريخ', 19, 'date'];
  const amountColumn = ['المبلغ', 16, 'number'];
  const currencyColumn = ['العملة', 10];
  const noteColumn = ['ملاحظة', 32];
  const nameOf = (map, id) => map.get(id)?.name || '';
  const toUsd = (values, rates) => values.USD + values.IQD / rates.iqd_per_usd + values.JOD / rates.jod_per_usd;
  const table = (name, columns, rows) => ({ name, columns, rows });
  const byDate = (a, b) => b.occurred_on.localeCompare(a.occurred_on);

  function build(state, month, today) {
    if (month && !monthPattern.test(month)) throw Error('اختار شهر صالح للتصدير.');
    const { accounts, entries, transfers, debt_people, debt_entries, settings } = state;
    const accountById = new Map(accounts.map(account => [account.id, account]));
    const personById = new Map(debt_people.map(person => [person.id, person]));
    const inPeriod = row => !month || row.occurred_on.slice(0, 7) === month;
    const periodEntries = entries.filter(inPeriod).sort(byDate);
    const periodTransfers = transfers.filter(inPeriod).sort(byDate);
    const periodDebts = debt_entries.filter(inPeriod).sort(byDate);
    const wallet = { IQD: 0, JOD: 0, USD: 0 };
    const debtNet = core.debtNet(null, debt_entries);
    const balances = accounts.map(account => {
      const current = core.balance(account, entries, transfers, debt_entries);
      wallet[account.currency] += current;
      return [account.name, account.currency, Number(account.opening_balance), current];
    });
    const totals = currencies.map(currency => [
      currency, wallet[currency], debtNet[currency], wallet[currency] + debtNet[currency]
    ]);
    totals.push(['USD (تقريبي)', toUsd(wallet, settings), toUsd(debtNet, settings), toUsd(wallet, settings) + toUsd(debtNet, settings)]);

    const months = new Map();
    const includeMonth = value => {
      if (!months.has(value)) months.set(value, []);
    };
    includeMonth(month || today.slice(0, 7));
    for (const row of [...periodTransfers, ...periodDebts]) includeMonth(row.occurred_on.slice(0, 7));
    for (const entry of periodEntries) {
      const key = entry.occurred_on.slice(0, 7);
      includeMonth(key);
      months.get(key).push(entry);
    }
    const budget = [...months.keys()].sort().reverse().flatMap(key => {
      const stats = core.monthStats({ ...state, entries: months.get(key) }, key);
      return [
        [key, 'الإجمالي', stats.total_budget_jod, stats.total_spent_jod, stats.total_remaining_jod],
        ...stats.rows.map(row => [key, row.category, row.limit_jod, row.spent_jod, row.remaining_jod])
      ];
    });

    const operations = periodEntries.map(entry => {
      const type = entry.category === core.balanceAdjustmentCategory ? 'تسوية رصيد'
        : { expense: 'مصروف', income: 'دخل', adjustment: 'تعديل رصيد' }[entry.kind];
      return [entry.occurred_on, nameOf(accountById, entry.account_id), type, entry.category,
        (entry.kind === 'expense' ? -1 : 1) * Number(entry.amount), accountById.get(entry.account_id)?.currency || '', entry.note];
    });
    const transferRows = periodTransfers.map(transfer => [
      transfer.occurred_on, nameOf(accountById, transfer.from_account_id), Number(transfer.from_amount),
      accountById.get(transfer.from_account_id)?.currency || '', nameOf(accountById, transfer.to_account_id),
      Number(transfer.to_amount), accountById.get(transfer.to_account_id)?.currency || '', transfer.note
    ]);
    const people = debt_people.flatMap(person => {
      const net = core.debtNet(person.id, debt_entries);
      return currencies.filter(currency => net[currency]).map(currency => [person.name, currency, net[currency]]);
    });
    const debts = periodDebts.map(debt => {
      const owedToMe = debt.direction === 'owed_to_me';
      const type = debt.settlement_account_id
        ? (owedToMe ? 'دفعت تسديد' : 'استلمت تسديد')
        : (owedToMe ? 'إلي عنده' : 'عليّ إله');
      return [debt.occurred_on, nameOf(personById, debt.person_id), type, (owedToMe ? 1 : -1) * Number(debt.amount),
        debt.currency, nameOf(accountById, debt.settlement_account_id), debt.note];
    });

    return {
      title: 'تقرير فلوسي',
      period: month || 'كل السجل',
      stamp: today,
      rates: `1 USD = ${settings.iqd_per_usd} IQD = ${settings.jod_per_usd} JOD`,
      context: 'الأرصدة الحالية وقت التصدير، والحركات حسب الفترة المختارة. الميزانية وأسعار الصرف حسب الإعدادات الحالية.',
      tables: [
        table('ملخص المحفظة', [currencyColumn, ['رصيد المحفظة', 22, 'number'], ['صافي الديون', 22, 'number'], ['الصافي بعد الديون', 24, 'number']], totals),
        table('الميزانية والمصاريف', [['الشهر', 14], ['التصنيف', 30, 'category'], ['الميزانية JOD', 18, 'number'], ['المصروف JOD', 18, 'number'], ['المتبقي JOD', 18, 'number']], budget),
        table('الحسابات', [['الحساب', 30], currencyColumn, ['الرصيد الافتتاحي', 22, 'number'], ['الرصيد الحالي', 22, 'number']], balances),
        table('العمليات', [dateColumn, ['الحساب', 25], ['النوع', 18], ['التصنيف', 23, 'category'], amountColumn, currencyColumn, noteColumn], operations),
        table('التحويلات', [dateColumn, ['من حساب', 21], ['المبلغ الخارج', 16, 'number'], currencyColumn, ['إلى حساب', 21], ['المبلغ الداخل', 16, 'number'], currencyColumn, noteColumn], transferRows),
        table('أرصدة الديون', [['الشخص', 30], currencyColumn, ['الصافي الحالي (إلي موجب)', 28, 'number']], people),
        table('حركات الديون', [dateColumn, ['الشخص', 24], ['النوع', 21], ['أثر الحركة على الدين', 22, 'number'], currencyColumn, ['حساب التسديد', 24], noteColumn], debts)
      ]
    };
  }

  async function excel(report, ExcelJS) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'فلوسي';
    workbook.title = report.title;
    for (const [index, section] of report.tables.entries()) {
      const sheet = workbook.addWorksheet(section.name);
      const headerRow = index === 0 ? 5 : 1;
      sheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: headerRow }];
      sheet.columns = section.columns.map(([, width, type]) => ({
        width,
        style: { numFmt: type === 'date' ? 'yyyy-mm-dd' : type === 'number' ? '#,##0.00#;[Red]-#,##0.00#;0' : 'General' }
      }));
      if (index === 0) {
        for (const [offset, text] of [report.title, `الفترة: ${report.period} · التصدير: ${report.stamp}`, report.context, report.rates].entries()) {
          const rowNumber = offset + 1;
          sheet.mergeCells(rowNumber, 1, rowNumber, section.columns.length);
          const cell = sheet.getCell(rowNumber, 1);
          cell.value = text;
          cell.alignment = { wrapText: true, horizontal: 'right' };
          if (offset === 2) sheet.getRow(rowNumber).height = 32;
        }
      }

      const header = sheet.addRow(section.columns.map(([label]) => label));
      header.height = 24;
      header.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF164D53' } };
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
      });
      for (const [index, values] of section.rows.entries()) {
        const row = sheet.addRow(values.map((value, column) =>
          value && section.columns[column][2] === 'date' ? new Date(value + 'T00:00:00Z') : value));
        row.eachCell(cell => {
          if (index % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F6F6' } };
          cell.alignment = { vertical: 'middle', wrapText: true };
        });
      }
      sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: sheet.rowCount, column: section.columns.length } };
    }
    return workbook.xlsx.writeBuffer();
  }

  function wrap(ctx, value, width) {
    const lines = [];
    for (const paragraph of value.split(/\r?\n/)) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        const combined = line ? line + ' ' + word : word;
        if (ctx.measureText(combined).width <= width) {
          line = combined;
          continue;
        }
        if (line) lines.push(line);
        line = '';
        for (const char of word) {
          if (line && ctx.measureText(line + char).width > width) {
            lines.push(line);
            line = '';
          }
          line += char;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  async function pdf(report, PDFLib, doc) {
    const pdfDoc = await PDFLib.PDFDocument.create();
    pdfDoc.setTitle(report.title);
    const width = 1122;
    const height = 794;
    const margin = 44;
    const bottom = height - 54;
    const lineHeight = 23;
    const canvas = doc.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw Error('تعذر تجهيز PDF على هذا المتصفح.');
    ctx.scale(2, 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    let pageNumber = 0;
    let y;

    function text(value, x, baseline, { bold = false, size = 16, color = '#19313a', direction = 'rtl' } = {}) {
      ctx.font = `${bold ? '700' : '400'} ${size}px ${reportFont}`;
      ctx.fillStyle = color;
      ctx.direction = direction;
      ctx.fillText(value, x, baseline);
    }
    function startPage() {
      pageNumber++;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#164d53';
      ctx.fillRect(0, 0, width, 7);
      text(report.title, width - margin, 56, { bold: true, size: 30 });
      text('الفترة', width - margin, 86, { color: '#3d5f69' });
      text(report.period, width - margin - 56, 86, { color: '#19313a', direction: monthPattern.test(report.period) ? 'ltr' : 'rtl' });
      text('تاريخ التصدير', width - margin - 177, 86, { color: '#3d5f69' });
      text(report.stamp, width - margin - 277, 86, { color: '#19313a', direction: 'ltr' });
      text(report.context, width - margin, 112, { color: '#3d5f69', size: 14 });
      text(report.rates, width - margin, 135, { direction: 'ltr', color: '#3d5f69', size: 14 });
      text(String(pageNumber), width - margin, height - 22, { direction: 'ltr', color: '#3d5f69', size: 13 });
      y = 158;
    }
    async function savePage() {
      const jpeg = await new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('تعذر إنشاء صفحة PDF.')), 'image/jpeg', 0.94);
      });
      const image = await pdfDoc.embedJpg(await jpeg.arrayBuffer());
      const page = pdfDoc.addPage([841.89, 595.28]);
      page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    }

    startPage();
    for (const section of report.tables) {
      const weights = section.columns.reduce((sum, [, weight]) => sum + weight, 0);
      const widths = section.columns.map(([, weight]) => (width - 2 * margin) * weight / weights);
      const rights = widths.map((_, index) => width - margin - widths.slice(0, index).reduce((sum, w) => sum + w, 0));

      function heading() {
        text(section.name, width - margin, y + 20, { bold: true, size: 20 });
        y += 30;
        ctx.font = `700 14px ${reportFont}`;
        const labels = section.columns.map(([label], index) => wrap(ctx, label, widths[index] - 20));
        const headerHeight = Math.max(...labels.map(lines => lines.length)) * 19 + 12;
        ctx.fillStyle = '#164d53';
        ctx.fillRect(margin, y, width - 2 * margin, headerHeight);
        labels.forEach((lines, index) => lines.forEach((line, offset) => {
          text(line, rights[index] - 10, y + 20 + offset * 19, { bold: true, size: 14, color: '#fff' });
        }));
        y += headerHeight;
      }
      if (y + 120 > bottom) {
        await savePage();
        startPage();
      }
      heading();
      if (section.rows.length === 0) {
        text('ماكو بيانات بهالفترة', width - margin - 10, y + 25, { color: '#3d5f69' });
        y += 37;
      }
      for (const [index, row] of section.rows.entries()) {
        ctx.font = `400 16px ${reportFont}`;
        const cells = row.map((value, column) => {
          const display = typeof value === 'number' ? numberFormat.format(value) : String(value ?? '—');
          const plainCategory = section.columns[column][2] === 'category'
            ? display.replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Emoji_Modifier}\p{Extended_Pictographic}]*\s+/u, '') : display;
          return wrap(ctx, plainCategory, widths[column] - 20);
        });
        const count = Math.max(...cells.map(lines => lines.length));
        let offset = 0;
        while (offset < count) {
          const linesAvailable = Math.floor((bottom - y - 10) / lineHeight);
          if (linesAvailable < 1) {
            await savePage();
            startPage();
            heading();
            continue;
          }
          const taken = Math.min(linesAvailable, count - offset);
          const rowHeight = taken * lineHeight + 10;
          ctx.fillStyle = index % 2 === 0 ? '#eff6f6' : '#fff';
          ctx.fillRect(margin, y, width - 2 * margin, rowHeight);
          cells.forEach((lines, column) => {
            const direction = ['date', 'number'].includes(section.columns[column][2]) ? 'ltr' : 'rtl';
            const color = typeof row[column] === 'number' && row[column] < 0 ? '#9b2d32' : '#19313a';
            lines.slice(offset, offset + taken).forEach((line, pos) => {
              text(line, rights[column] - 10, y + 21 + pos * lineHeight, { direction, color });
            });
          });
          y += rowHeight;
          offset += taken;
        }
      }
      y += 25;
    }
    await savePage();
    return pdfDoc.save();
  }

  const api = { build, excel, pdf };
  if (typeof module !== 'undefined') module.exports = api;
  else root.FuloosiReports = api;
})(typeof window !== 'undefined' ? window : globalThis);
