import * as XLSX from 'xlsx';
import * as codepages from 'xlsx/dist/cpexcel.full.mjs';
import { decodePreviewText } from './document-preview.ts';
import { verifyOfficeArchive } from './office-preview.ts';

XLSX.set_cptable(codepages);

export const SPREADSHEET_LIMITS = { bytes: 25 * 1024 * 1024, rows: 200, columns: 40, sheets: 100, text: 2000 } as const;
export interface SpreadsheetCell { text: string; rowSpan: number; colSpan: number }
export interface SpreadsheetView {
  columns: string[];
  rows: (SpreadsheetCell | null)[][];
  truncatedRows: boolean;
  truncatedColumns: boolean;
  truncatedText: boolean;
  truncatedMerges: boolean;
}

export function spreadsheetError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/password|encrypt|filepass|cryptoapi|rc4/i.test(message)) return '此工作簿已加密或需要密码。请先在本地表格应用中解密并另存后预览。';
  return '无法读取工作簿：文件格式不受支持、内容已损坏，或文件并非有效的表格文件。';
}

/** Verify actual ZIP output before SheetJS runs; the row/column limits only bound the rendered table. */
export async function readSpreadsheet(input: Uint8Array<ArrayBuffer> | string, extension = 'xlsx', signal?: AbortSignal): Promise<XLSX.WorkBook> {
  signal?.throwIfAborted();
  if (typeof input !== 'string') {
    if (input.byteLength > SPREADSHEET_LIMITS.bytes) throw new Error('表格超过 25 MiB，无法在侧栏预览。请通过文件菜单在本地应用中打开。');
    if (extension !== 'csv' && extension !== 'tsv' && input[0] === 0x50 && input[1] === 0x4b && input[2] === 3 && input[3] === 4) {
      await verifyOfficeArchive(input, signal);
    }
  }
  signal?.throwIfAborted();
  return parseSpreadsheet(input, extension);
}

/** Synchronous parser for already verified input; production ZIP callers must use readSpreadsheet first. */
export function parseSpreadsheet(input: Uint8Array | ArrayBuffer | string, extension = 'xlsx'): XLSX.WorkBook {
  const delimited = extension === 'csv' || extension === 'tsv';
  if (typeof input === 'string' && !delimited) throw new Error('表格预览需要完整的二进制文件，无法使用文本内容。');
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > SPREADSHEET_LIMITS.bytes) throw new Error('表格超过 25 MiB，无法在侧栏预览。请通过文件菜单在本地应用中打开。');
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  const compound = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => bytes[index] === value);
  const biff = bytes[0] === 9 && [0, 2, 4, 8].includes(bytes[1]) && bytes.length >= 8;
  // SheetJS otherwise deliberately interprets text disguised as XLS as CSV.
  if (!delimited && !zip && !compound && !biff) throw new Error(spreadsheetError('format'));
  const text = delimited ? typeof input === 'string' ? input : decodePreviewText(bytes).text : undefined;
  try {
    const workbook = XLSX.read(text ?? bytes, {
      type: delimited ? 'string' : 'array', ...(delimited ? { raw: true, ...(extension === 'tsv' ? { FS: '\t' } : {}) } : {}),
      cellHTML: false, cellFormula: false, cellDates: true,
      cellText: true, sheetRows: SPREADSHEET_LIMITS.rows + 1, dense: false,
    });
    if (!workbook.SheetNames.length) throw new Error('No worksheets');
    return workbook;
  } catch (error) { throw new Error(spreadsheetError(error)); }
}

function validPoint(point: XLSX.CellAddress): boolean {
  return Number.isInteger(point.r) && point.r >= 0 && point.r < 1048576 && Number.isInteger(point.c) && point.c >= 0 && point.c < 16384;
}

/** Clamp before iterating: even A1:XFD1048576 produces at most 8,000 table cells. */
export function spreadsheetView(sheet: XLSX.WorkSheet): SpreadsheetView {
  const reference = sheet['!fullref'] ?? sheet['!ref'];
  const empty = { columns: [], rows: [], truncatedRows: false, truncatedColumns: false, truncatedText: false, truncatedMerges: false };
  if (!reference) return empty;
  if (typeof reference !== 'string' || !/^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/.test(reference)) throw new Error('工作表的单元格范围无效，无法预览。');
  const range = XLSX.utils.decode_range(reference);
  if (!validPoint(range.s) || !validPoint(range.e) || range.s.r > range.e.r || range.s.c > range.e.c) throw new Error('工作表的单元格范围无效，无法预览。');
  const rowCount = Math.min(range.e.r + 1, SPREADSHEET_LIMITS.rows);
  const columnCount = Math.min(range.e.c + 1, SPREADSHEET_LIMITS.columns);
  let truncatedText = false;
  const rows: (SpreadsheetCell | null)[][] = Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => {
    const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
    const text = cell ? XLSX.utils.format_cell(cell) : '';
    if (text.length > SPREADSHEET_LIMITS.text) truncatedText = true;
    return { text: text.length > SPREADSHEET_LIMITS.text ? text.slice(0, SPREADSHEET_LIMITS.text) + '…' : text, rowSpan: 1, colSpan: 1 };
  }));
  const merges = sheet['!merges'] ?? [];
  let truncatedMerges = merges.length > SPREADSHEET_LIMITS.rows * SPREADSHEET_LIMITS.columns;
  for (const merge of merges.slice(0, SPREADSHEET_LIMITS.rows * SPREADSHEET_LIMITS.columns)) {
    if (!merge?.s || !merge.e || !validPoint(merge.s) || !validPoint(merge.e) || merge.s.r > merge.e.r || merge.s.c > merge.e.c) continue;
    const { r, c } = merge.s;
    const anchor = rows[r]?.[c];
    if (!anchor || anchor.rowSpan > 1 || anchor.colSpan > 1) continue;
    const endRow = Math.min(merge.e.r, rowCount - 1);
    const endColumn = Math.min(merge.e.c, columnCount - 1);
    if (endRow !== merge.e.r || endColumn !== merge.e.c) truncatedMerges = true;
    anchor.rowSpan = endRow - r + 1;
    anchor.colSpan = endColumn - c + 1;
    for (let row = r; row <= endRow; row++) for (let column = c; column <= endColumn; column++) {
      if (row !== r || column !== c) rows[row][column] = null;
    }
  }
  return {
    columns: Array.from({ length: columnCount }, (_, c) => XLSX.utils.encode_col(c)), rows,
    truncatedRows: range.e.r >= rowCount, truncatedColumns: range.e.c >= columnCount, truncatedText, truncatedMerges,
  };
}
