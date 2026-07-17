// TSV codec for the Data Loop table — THE only module allowed to touch CSV-style
// quoting. The panel's canonical state is plain string arrays ({ headers, rows },
// the exact data:save wire shape); quoting exists only at the paste/copy boundary,
// so grid edits never re-encode anything.

export interface Grid {
  headers: string[];
  rows: string[][];
}

// Tokenize a pasted TSV block (Excel/Sheets copy = tab-separated cells, newline rows)
// into a grid, honouring CSV-style quoting: a cell wrapped in double quotes may contain
// tabs and newlines, and "" is a literal quote. Excel/Sheets quote any cell holding a
// tab, newline, or quote, so without this a multi-line message-body cell would be torn
// across rows. Unquoted cells pass through verbatim (so values keep spaces).
export function tokenizeTsvGrid(text: string, delim: string = '\t'): string[][] {
  const src = text.replace(/\r\n/g, '\n');
  const grid: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { inQuotes = true; i++; continue; } // opening quote (start of cell)
    if (ch === delim) { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\n') { row.push(cell); grid.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  // Flush the last cell/row (no trailing newline).
  row.push(cell);
  grid.push(row);
  return grid;
}

// Guess a CSV/TSV file's delimiter from its first line — tab, semicolon, or comma (Brazilian Excel
// writes ';'). Whichever is most frequent on line 1 wins; defaults to tab when none appears. The
// quote-unaware count is fine for a heuristic (a delimiter inside a quoted header is rare).
export function sniffDelimiter(text: string): string {
  const firstLine = text.replace(/\r\n/g, '\n').split('\n', 1)[0] ?? '';
  const counts: [string, number][] = [
    ['\t', (firstLine.match(/\t/g) || []).length],
    [';', (firstLine.match(/;/g) || []).length],
    [',', (firstLine.match(/,/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : '\t';
}

// Parse pasted TSV into a data table. Trailing all-empty rows are dropped. When
// firstRowHeader is off, headers are synthesized col1..colN sized to the widest row.
export function parseTsv(text: string, firstRowHeader: boolean): Grid {
  if (text.trim() === '') return { headers: [], rows: [] };
  const grid = tokenizeTsvGrid(text);
  // Drop trailing rows that are entirely empty (a paste often ends with a newline).
  while (grid.length && grid[grid.length - 1].every((c) => c.trim() === '')) grid.pop();
  if (grid.length === 0) return { headers: [], rows: [] };
  let headers: string[];
  let bodyRows: string[][];
  if (firstRowHeader) {
    headers = grid[0].map((h) => h.trim());
    bodyRows = grid.slice(1);
  } else {
    const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
    headers = Array.from({ length: width }, (_, i) => `col${i + 1}`);
    bodyRows = grid;
  }
  return { headers, rows: bodyRows };
}

// Re-encode a grid as TSV with the same quoting tokenizeTsvGrid understands —
// cells holding tabs/newlines/quotes get wrapped, quotes doubled. Used by the
// paste-surface prefill and Copy table (TSV): one codec pair, round-trip by
// construction.
export function encodeTsv(headers: string[], rows: string[][]): string {
  const enc = (c: string) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return [headers, ...rows].map((r) => r.map(enc).join('\t')).join('\n');
}

// Structural equality for the dirty flag — array identity is the contract
// (byte-identical TSV is not; quoting is presentation).
export function deepEqualGrid(a: Grid, b: Grid): boolean {
  if (a.headers.length !== b.headers.length || a.rows.length !== b.rows.length) return false;
  for (let i = 0; i < a.headers.length; i++) if (a.headers[i] !== b.headers[i]) return false;
  for (let r = 0; r < a.rows.length; r++) {
    const ra = a.rows[r], rb = b.rows[r];
    if (ra.length !== rb.length) return false;
    for (let c = 0; c < ra.length; c++) if (ra[c] !== rb[c]) return false;
  }
  return true;
}
