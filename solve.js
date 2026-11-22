// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// run(input) returns exactly what csv-reader 1.0.0's readCsv returns for the
// same {text, header}: {columns, rows, errors}. It is written from the
// reference's stated policy (and checked against its code), not by wrapping it:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, and each CRLF or lone CR inside it read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that never
//     closes is a literal character, and the text after it is read again as
//     unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, a record's short_row or
//     long_row when it ends: line the 1-based line its record starts on, counting
//     every LF, CRLF and lone CR inside quotes, and row its record's index in
//     rows, null for the header.
//
// Speed comes from letting the engine do the scanning: a line with no quote is
// read with one slice and one split; an unquoted field ends at the next comma,
// LF or CR found by one regex scan; a quoted field ends at its closing quote
// found by indexOf, and its content is taken as one slice (replaced only when
// it holds "" or a line break). The reference reads one character at a time and
// builds every field a character at a time; this does the same reading with
// bulk operations. Nothing is kept from one call to the next.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 'comma';
const LINE_BREAK = 'line break';
const END = 'end';

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recLine = 1;
  let recRow = null;

  // The field just read: its value, how it ended, and how many characters readUnquoted kept after its starting value.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Sets fValue/fEnded/fAdded.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      const iC = text.indexOf(',', pos);
      const iN = text.indexOf('\n', pos);
      let d;
      let kind; // 0: end of text, 1: comma, 2: LF
      if (iC === -1) {
        if (iN === -1) { d = len; kind = 0; } else { d = iN; kind = 2; }
      } else if (iN === -1) { d = iC; kind = 1; }
      else if (iC < iN) { d = iC; kind = 1; }
      else { d = iN; kind = 2; }
      const seg = text.slice(pos, d);
      const r = seg.indexOf('\r');
      if (r === -1) {
        value += seg;
        added += seg.length;
        if (kind === 0) {
          pos = len;
          fValue = value; fEnded = END; fAdded = added;
          return;
        }
        if (kind === 1) {
          pos = d + 1;
          fValue = value; fEnded = COMMA; fAdded = added;
          return;
        }
        pos = d + 1;
        line += 1;
        fValue = value; fEnded = LINE_BREAK; fAdded = added;
        return;
      }
      if (kind === 2 && r === seg.length - 1) {
        // The CR is the CRLF before this LF: the field ends here.
        const v = seg.slice(0, r);
        value += v;
        added += v.length;
        pos = d + 1;
        line += 1;
        fValue = value; fEnded = LINE_BREAK; fAdded = added;
        return;
      }
      // A lone CR inside the field: dropped (stray_cr), and the field goes on.
      errors.push({ code: 'stray_cr', line: recLine, row: recRow });
      const v = seg.slice(0, r);
      value += v;
      added += v.length;
      pos = pos + r + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue/fEnded/fAdded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let q = text.indexOf('"', pos + 1);
    let doubled = false;
    while (q !== -1 && text.charCodeAt(q + 1) === 34) {
      doubled = true;
      q = text.indexOf('"', q + 2);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
      pos = open + 1;
      line = openLine;
      readUnquoted('"');
      return;
    }
    let value = text.slice(open + 1, q);
    if (value.indexOf('\n') !== -1 || value.indexOf('\r') !== -1) {
      // Each CRLF and each lone CR inside quotes is one LF, and each LF one line:
      // line breaks = CRs + LFs - CRLF pairs.
      line += value.split('\r').length - 1 + value.split('\n').length - 1 - (value.split('\r\n').length - 1);
      value = value.replace(/\r\n?/g, '\n');
    }
    if (doubled) value = value.replace(/""/g, '"');
    pos = q + 1;
    if (pos >= len) {
      fValue = value; fEnded = END; fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value; fEnded = COMMA; fAdded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value; fEnded = LINE_BREAK; fAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value; fEnded = LINE_BREAK; fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recLine, row: recRow });
  }

  // Finishes a record's fields: the header, or a row padded or cut to the first record's width.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // Reads one record whose first line holds a quote, field by field from pos (it may span lines).
  function readRecordSlow() {
    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted(); else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);
    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    finishRecord(fields);
  }

  while (pos < len) {
    // The current line ends at its LF (or the end of the text). A quote on it means the record needs the
    // field-by-field reader; without one the record ends on this line, and its fields are one split.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    const q = text.indexOf('"', pos);
    if (q !== -1 && q < lineEnd) {
      readRecordSlow();
      continue;
    }
    // A trailing CR is the line's CRLF, not its content.
    let contentEnd = lineEnd;
    if (nl !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) contentEnd = lineEnd - 1;
    const content = text.slice(pos, contentEnd);
    if (content === '') {
      // A line left with no characters is no record.
      pos = lineEnd + (nl === -1 ? 0 : 1);
      line += 1;
      continue;
    }
    // No quote on this line: the record ends on it, and its fields are one split.
    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    let fields;
    if (content.indexOf('\r') === -1) {
      fields = content.split(',');
    } else {
      // Every CR left in the line is a lone one: one stray_cr each, dropped.
      const n = content.split('\r').length - 1;
      for (let i = 0; i < n; i++) errors.push({ code: 'stray_cr', line: recLine, row: recRow });
      const clean = content.replace(/\r/g, '');
      if (clean === '') {
        // The line held only stray CRs: no record (its stray_cr errors stay).
        pos = lineEnd + (nl === -1 ? 0 : 1);
        line += 1;
        continue;
      }
      fields = clean.split(',');
    }
    pos = lineEnd + (nl === -1 ? 0 : 1);
    line += 1;
    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
