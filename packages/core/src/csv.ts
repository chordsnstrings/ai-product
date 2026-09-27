/**
 * CSV for merchant uploads (Ads Manager exports, review-app exports). RFC 4180: quoted fields may hold the
 * delimiter, quotes ("" inside quotes) and line breaks. Exports from European locales use `;` and some tools use
 * tabs: the delimiter is taken from the header line. A leading byte-order mark is dropped.
 */
export function parseCsv(raw: string, delimiter?: ',' | ';' | '\t'): string[][] {
  const text = raw.replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell.trim() === '') {
      cell = '';
      quoted = true;
    } else if (c === d) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** The header line's delimiter: whichever of , ; and tab occurs most outside quotes. */
function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<',' | ';' | '\t', number>;
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in counts) counts[c as ',' | ';' | '\t']++;
  }
  const [best, n] = (Object.entries(counts) as [',' | ';' | '\t', number][]).sort((a, b) => b[1] - a[1])[0]!;
  return n > 0 ? best : ',';
}

/**
 * A number as exports write it, whatever the locale: `1,234.56`, `1.234,56`, `1 234,56`, `$12.50`, `€9`, `12%`.
 * With both separators the last one is the decimal point; a lone comma is a thousands separator only in the
 * `1,234,567` pattern. `decimal` settles the ambiguous cases (`12.000` is twelve thousand in a comma-decimal file);
 * see detectDecimal. Empty, `-` and `--` are 0; anything else unreadable is NaN.
 */
export function parseLocaleNumber(v: string | null | undefined, decimal?: ',' | '.'): number {
  let s = String(v ?? '').trim().replace(/[\s  ]/g, '').replace(/[^\d.,\-+eE]/g, '');
  if (!s || /^[-+]+$/.test(s)) return 0;
  if (decimal) {
    s = decimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    if ((s.match(/\./g) ?? []).length > 1) return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = /^[-+]?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
    if ((s.match(/\./g) ?? []).length > 1) return NaN;
  } else if ((s.match(/\./g) ?? []).length > 1) {
    // 1.234.567 — dots as thousands separators.
    s = /^[-+]?\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : 'x';
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * The decimal separator a file's numbers use, from values that show it unambiguously: both separators (the last
 * one is the decimal), or a single separator followed by one or two digits (`12,50`). Null when nothing tells.
 */
export function detectDecimal(values: string[]): ',' | '.' | null {
  for (const raw of values) {
    const v = raw.replace(/[^\d.,]/g, '');
    const dot = v.lastIndexOf('.');
    const comma = v.lastIndexOf(',');
    if (dot >= 0 && comma >= 0) return comma > dot ? ',' : '.';
    if (/,\d{1,2}$/.test(v)) return ',';
    if (/\.\d{1,2}$/.test(v)) return '.';
  }
  return null;
}
