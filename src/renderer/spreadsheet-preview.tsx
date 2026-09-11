import { useEffect, useId, useMemo, useState } from 'react';
import type { WorkBook } from 'xlsx';
import type { DocumentProps } from './document-preview.tsx';
import { documentExtension } from '../shared/document-preview.ts';
import { readSpreadsheet, spreadsheetView, SPREADSHEET_LIMITS } from '../shared/spreadsheet-preview.ts';
import './spreadsheet-preview.css';

export function SpreadsheetDocument({ resourceAddress, content, wrap }: DocumentProps) {
  const input = content.kind === 'bytes' ? content.data : content.text;
  const [result, setResult] = useState<{ input: typeof input; address: string; workbook?: WorkBook; error?: string }>();
  const [selected, setSelected] = useState(0);
  const id = useId();
  useEffect(() => {
    setSelected(0);
    const cancellation = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const workbook = await readSpreadsheet(input, documentExtension(resourceAddress), cancellation.signal);
        if (!cancellation.signal.aborted) setResult({ input, address: resourceAddress, workbook });
      } catch (error) {
        if (!cancellation.signal.aborted) setResult({ input, address: resourceAddress, error: (error as Error).message });
      }
    }, 0);
    return () => { cancellation.abort(); clearTimeout(timer); };
  }, [input, resourceAddress]);
  const current = result?.input === input && result?.address === resourceAddress ? result : undefined;
  const names = current?.workbook?.SheetNames.slice(0, SPREADSHEET_LIMITS.sheets) ?? [];
  const index = Math.min(selected, Math.max(0, names.length - 1));
  const sheet = current?.workbook?.Sheets[names[index]];
  const view = useMemo(() => {
    try { return sheet ? { table: spreadsheetView(sheet) } : {}; }
    catch (error) { return { error: (error as Error).message }; }
  }, [sheet]);
  const table = view.table;
  return <section className="desktop-document desktop-spreadsheet" data-document-preview="spreadsheet" aria-busy={!current}>
    {!current && <p role="status">正在读取表格…</p>}
    {(current?.error || view.error) && <p role="alert">{current?.error || view.error}</p>}
    {names.length > 0 && <>
      <div className="desktop-spreadsheet-tabs" role="tablist" aria-label="工作表">
        {names.map((name, tab) => <button type="button" role="tab" id={`${id}-tab-${tab}`} aria-controls={`${id}-table`} aria-selected={tab === index} key={tab} onClick={() => setSelected(tab)}>{name}</button>)}
      </div>
      <p className="desktop-spreadsheet-note">仅显示已保存的单元格内容，不重新计算公式或打开外部链接。</p>
      <p className="desktop-spreadsheet-note">预览范围：前 {SPREADSHEET_LIMITS.rows} 行、{SPREADSHEET_LIMITS.columns} 列。</p>
      {(current?.workbook?.SheetNames.length ?? 0) > names.length && <p role="status">工作表过多，仅提供前 {SPREADSHEET_LIMITS.sheets} 个工作表的预览。</p>}
      {table && <div role="tabpanel" id={`${id}-table`} aria-labelledby={`${id}-tab-${index}`}>
        {(table.truncatedRows || table.truncatedColumns) && <p className="desktop-spreadsheet-note" role="status">预览已截断：最多显示前 {SPREADSHEET_LIMITS.rows} 行、{SPREADSHEET_LIMITS.columns} 列。完整内容请在本地表格应用中打开。</p>}
        {table.truncatedText && <p className="desktop-spreadsheet-note" role="status">过长的单元格仅显示前 {SPREADSHEET_LIMITS.text} 个字符。</p>}
        {table.truncatedMerges && <p className="desktop-spreadsheet-note" role="status">部分合并单元格超出预览范围，仅显示可见部分。</p>}
        {!table.rows.length ? <p>预览范围内未读取到单元格；工作表可能为空，或数据位于范围之外。</p> : <div className="desktop-spreadsheet-scroll">
          <table aria-label={`${names[index]} 工作表`} style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}>
            <thead><tr><th aria-label="行号" />{table.columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
            <tbody>{table.rows.map((row, r) => <tr key={r}><th scope="row">{r + 1}</th>{row.map((cell, c) => cell && <td key={c} rowSpan={cell.rowSpan} colSpan={cell.colSpan}>{cell.text}</td>)}</tr>)}</tbody>
          </table>
        </div>}
      </div>}
    </>}
  </section>;
}
