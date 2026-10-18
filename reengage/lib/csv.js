// Minimal RFC 4180 CSV parser: handles quoted fields, escaped quotes and newlines in quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text).replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

// Turns CSV rows into objects keyed by lower-cased header names.
export function csvToRecords(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map(h => h.trim().toLowerCase());
  return rows.map((r, i) => ({
    line: i + 2,
    record: Object.fromEntries(keys.map((k, j) => [k, (r[j] ?? '').trim()])),
  }));
}

export function isTruthy(value) {
  return /^(1|y|yes|true|x)$/i.test(String(value ?? '').trim());
}
