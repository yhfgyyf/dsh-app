import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { readSpreadsheet, parseSpreadsheet, spreadsheetView, spreadsheetError, SPREADSHEET_LIMITS } from '../src/shared/spreadsheet-preview.ts';

function fixture(bookType: XLSX.BookType, compression = false) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['中文工作簿', '单元格'], ['数据', 12.5]]);
  XLSX.utils.book_append_sheet(workbook, sheet, '第一张');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['第二张数据']]), '第二张');
  return XLSX.write(workbook, { bookType, type: 'array', codepage: 936, compression }) as ArrayBuffer;
}

test('real XLSX and legacy binary XLS workbooks preserve Chinese sheets and values', () => {
  for (const format of ['xlsx', 'biff8'] as const) {
    const workbook = parseSpreadsheet(fixture(format));
    assert.deepEqual(workbook.SheetNames, ['第一张', '第二张']);
    const first = spreadsheetView(workbook.Sheets['第一张']);
    assert.equal(first.rows[0][0]?.text, '中文工作簿');
    assert.equal(first.rows[1][1]?.text, '12.5');
    assert.equal(spreadsheetView(workbook.Sheets['第二张']).rows[0][0]?.text, '第二张数据');
  }
});

test('production reader verifies ZIP spreadsheets while preserving XLS, ODS, XLSB and delimited input', async () => {
  for (const format of ['xlsx', 'ods', 'xlsb', 'biff8'] as const) {
    const workbook = await readSpreadsheet(new Uint8Array(fixture(format, true)), format === 'biff8' ? 'xls' : format);
    assert.deepEqual(workbook.SheetNames, ['第一张', '第二张']);
    assert.equal(spreadsheetView(workbook.Sheets['第一张']).rows[0][0]?.text, '中文工作簿');
  }
  const csv = await readSpreadsheet(new TextEncoder().encode('name,value\ntext,42'), 'csv');
  assert.equal(spreadsheetView(csv.Sheets[csv.SheetNames[0]]).rows[1][1]?.text, '42');
});

test('production reader rejects false ZIP sizes and keeps the stricter compressed input limit', async () => {
  const source = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(source, XLSX.utils.aoa_to_sheet([['中文工作簿', 42]]), '数据');
  const bytes = new Uint8Array(XLSX.write(source, { bookType: 'xlsx', type: 'array', compression: true }) as ArrayBuffer);
  const view = new DataView(bytes.buffer);
  const directory = view.getUint32(bytes.length - 22 + 16, true);
  const local = view.getUint32(directory + 42, true);
  assert.equal(view.getUint32(directory, true), 0x02014b50);
  assert.ok(view.getUint32(directory + 24, true) > 1);
  view.setUint32(directory + 24, 1, true);
  view.setUint32(local + 22, 1, true);
  await assert.rejects(readSpreadsheet(bytes));
  const oversized = new Uint8Array(SPREADSHEET_LIMITS.bytes + 1);
  oversized.set([0x50, 0x4b, 3, 4]);
  await assert.rejects(readSpreadsheet(oversized), /25 MiB/);
});

test('production reads honor cancellation before parsing and during ZIP verification', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(readSpreadsheet('name,value', 'csv', before.signal), { name: 'AbortError' });
  const during = new AbortController();
  const pending = readSpreadsheet(new Uint8Array(fixture('xlsx', true)), 'xlsx', during.signal);
  during.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('BIFF2 CODEPAGE 936 records decode real GBK bytes rather than assuming Unicode XLS', () => {
  const record = (id: number, payload: number[]) => {
    const bytes = Buffer.alloc(payload.length + 4);
    bytes.writeUInt16LE(id, 0); bytes.writeUInt16LE(payload.length, 2);
    Buffer.from(payload).copy(bytes, 4);
    return bytes;
  };
  const bof = record(0x0009, [2, 0, 0x10, 0]);
  const codepage = record(0x0042, [0xa8, 0x03]);
  const label = record(0x0004, [0, 0, 0, 0, 0, 0, 0, 4, 0xd6, 0xd0, 0xce, 0xc4]);
  const eof = record(0x000a, []);
  const workbook = parseSpreadsheet(Buffer.concat([bof, codepage, label, eof]), 'xls');
  assert.equal(spreadsheetView(workbook.Sheets.Sheet1).rows[0][0]?.text, '中文');
  const encrypted = Buffer.concat([bof, record(0x002f, [0, 0, 0, 0]), codepage, label, eof]);
  assert.throws(() => parseSpreadsheet(encrypted, 'xls'), /已加密或需要密码/);
});

test('shared fixture retains both named sheets and saved results', () => {
  const workbook = parseSpreadsheet(readFileSync(new URL('./fixtures/document-preview/sample.xlsx', import.meta.url)));
  assert.deepEqual(workbook.SheetNames, ['销售数据', '汇总']);
  const sales = spreadsheetView(workbook.Sheets['销售数据']).rows.flat().map(cell => cell?.text);
  assert.ok(sales.includes('50') && sales.includes('24') && sales.includes('74'));
  assert.ok(spreadsheetView(workbook.Sheets['汇总']).rows.flat().some(cell => cell?.text === 'XLSX_SECOND_SHEET_OK'));
});

test('CSV and TSV are allowed explicitly, with quoted commas, Chinese encodings and literal formula text', () => {
  const csv = parseSpreadsheet(new TextEncoder().encode('名称,备注\r\n中文,"含,逗号"\r\n=1+1,安全'), 'csv');
  const view = spreadsheetView(csv.Sheets[csv.SheetNames[0]]);
  assert.equal(view.rows[1][0]?.text, '中文');
  assert.equal(view.rows[1][1]?.text, '含,逗号');
  assert.equal(view.rows[2][0]?.text, '=1+1');
  const tsv = parseSpreadsheet(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 9, 49, 13, 10]), 'tsv');
  assert.deepEqual(spreadsheetView(tsv.Sheets[tsv.SheetNames[0]]).rows[0].map(cell => cell?.text), ['中文', '1']);
  assert.throws(() => parseSpreadsheet('名称,备注', 'xls'), /二进制/);
});

test('XLSX dates, merged cells, literal markup and cached formula values survive preview', () => {
  const sheet = XLSX.utils.aoa_to_sheet([['合并', null, '日期'], ['<img src=x onerror=alert(1)>', 42, new Date(2026, 8, 11)]]);
  sheet.C2.z = 'yyyy-mm-dd';
  sheet.B2.f = 'WEBSERVICE("https://example.invalid/")';
  sheet.A2.l = { Target: 'javascript:alert(1)' };
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  const source = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(source, sheet, '日期');
  const workbook = parseSpreadsheet(XLSX.write(source, { type: 'array', bookType: 'xlsx' }));
  const view = spreadsheetView(workbook.Sheets['日期']);
  assert.equal(view.rows[0][0]?.colSpan, 2);
  assert.equal(view.rows[0][1], null);
  assert.equal(view.rows[1][0]?.text, '<img src=x onerror=alert(1)>');
  assert.deepEqual(Object.keys(view.rows[1][0]!).sort(), ['colSpan', 'rowSpan', 'text']);
  assert.equal(view.rows[1][1]?.text, '42');
  assert.equal(view.rows[1][2]?.text, '2026-09-11');
  assert.equal(workbook.Sheets['日期'].B2.f, undefined);
});

test('huge sparse worksheet ranges and merges are clamped before table construction', () => {
  const sheet: XLSX.WorkSheet = {
    A1: { t: 's', v: 'x'.repeat(SPREADSHEET_LIMITS.text + 1) },
    '!ref': 'A1:XFD1048576',
    '!merges': [{ s: { r: 0, c: 0 }, e: { r: 1048575, c: 16383 } }],
  };
  const view = spreadsheetView(sheet);
  assert.equal(view.rows.length, SPREADSHEET_LIMITS.rows);
  assert.equal(view.columns.length, SPREADSHEET_LIMITS.columns);
  assert.equal(view.rows[0][0]?.rowSpan, SPREADSHEET_LIMITS.rows);
  assert.equal(view.rows[0][0]?.colSpan, SPREADSHEET_LIMITS.columns);
  assert.equal(view.rows[0][0]?.text.length, SPREADSHEET_LIMITS.text + 1);
  assert.equal(view.truncatedRows && view.truncatedColumns && view.truncatedText && view.truncatedMerges, true);
});

test('row-limited parsing retains full ranges without re-reading distant cells', () => {
  const source = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(source, { A1000: { t: 's', v: '远处数据' }, '!ref': 'A1000:A1000' }, 'Sparse');
  const workbook = parseSpreadsheet(XLSX.write(source, { type: 'array', bookType: 'xlsx' }));
  const view = spreadsheetView(workbook.Sheets.Sparse);
  assert.equal(view.truncatedRows, true);
  assert.equal(view.rows.length, SPREADSHEET_LIMITS.rows);
  assert.equal(workbook.Sheets.Sparse.A1000, undefined);
});

test('invalid files, malformed ranges, encryption errors and oversized input give clear messages', () => {
  assert.throws(() => parseSpreadsheet(new TextEncoder().encode('plain text,not an XLS workbook')), /有效的表格/);
  assert.throws(() => parseSpreadsheet(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])), /损坏/);
  assert.throws(() => parseSpreadsheet(new Uint8Array(SPREADSHEET_LIMITS.bytes + 1)), /25 MiB/);
  assert.throws(() => spreadsheetView({ '!ref': 'A1:ZZZ99999999999999' }), /范围无效/);
  assert.match(spreadsheetError(new Error('File is password-protected')), /已加密或需要密码/);
  assert.deepEqual(spreadsheetView({}).rows, []);
});
