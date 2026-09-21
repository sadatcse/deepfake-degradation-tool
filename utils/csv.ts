/**
 * Minimal RFC-4180 CSV writer. No dependency, no database - just text.
 */

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines: string[] = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(','));
  }
  // Trailing newline keeps POSIX tools happy.
  return `${lines.join('\r\n')}\r\n`;
}
