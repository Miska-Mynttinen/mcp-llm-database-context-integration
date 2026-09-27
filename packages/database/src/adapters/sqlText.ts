/** How a dialect writes text that is not SQL code: strings, quoted identifiers and comments. */
export interface SqlTextRules {
  /** Backslash escapes a character inside '...' and "..." (MySQL's default). */
  readonly backslashEscapes: boolean;
  /** `$tag$ ... $tag$` strings and `E'...'` strings with backslash escapes (PostgreSQL). */
  readonly postgresStrings: boolean;
  /** `#` starts a line comment (MySQL). */
  readonly hashComments: boolean;
}

export const POSTGRES_TEXT: SqlTextRules = { backslashEscapes: false, postgresStrings: true, hashComments: false };
export const MYSQL_TEXT: SqlTextRules = { backslashEscapes: true, postgresStrings: false, hashComments: true };

const DOLLAR_QUOTE_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const WORD_CHAR = /\w/;

/**
 * `sql` with every string literal, quoted identifier and comment blanked to spaces, so what is
 * left is code that can be searched for placeholders and keywords. Same length as `sql`, so an
 * index into the result is an index into `sql`.
 */
export function blankQuotedText(sql: string, rules: SqlTextRules): string {
  const chunks: string[] = [];
  let position = 0;
  while (position < sql.length) {
    const end = quotedTextEnd(sql, position, rules);
    chunks.push(end === position ? sql[position] : ' '.repeat(end - position));
    position = Math.max(end, position + 1);
  }
  return chunks.join('');
}

/** The index of every `?` placeholder in `sql`, skipping any inside quoted text or comments. */
export function placeholderIndexes(sql: string, rules: SqlTextRules): number[] {
  const code = blankQuotedText(sql, rules);
  return [...code].flatMap((char, index) => (char === '?' ? [index] : []));
}

/** Whether `keyword` appears in `sql` outside quoted text, comments and parentheses. */
export function hasTopLevelKeyword(sql: string, keyword: string, rules: SqlTextRules): boolean {
  const code = blankQuotedText(sql, rules);
  const pattern = new RegExp(`\\b${keyword}\\b`, 'iy');
  let depth = 0;
  for (let index = 0; index < code.length; index++) {
    if (code[index] === '(') depth++;
    else if (code[index] === ')') depth--;
    else if (depth === 0) {
      pattern.lastIndex = index;
      if (pattern.test(code)) return true;
    }
  }
  return false;
}

/** Where the quoted text or comment starting at `start` ends, or `start` if none starts there. */
function quotedTextEnd(sql: string, start: number, rules: SqlTextRules): number {
  const char = sql[start];
  const next = sql[start + 1];
  if ((char === '-' && next === '-') || (char === '#' && rules.hashComments)) {
    const newline = sql.indexOf('\n', start);
    return newline === -1 ? sql.length : newline;
  }
  if (char === '/' && next === '*') {
    const close = sql.indexOf('*/', start + 2);
    return close === -1 ? sql.length : close + 2;
  }
  if (char === "'") {
    return closingQuote(sql, start, rules.backslashEscapes || (rules.postgresStrings && isEscapeStringPrefix(sql, start)));
  }
  if (char === '"') {
    return closingQuote(sql, start, rules.backslashEscapes);
  }
  if (char === '`') {
    return closingQuote(sql, start, false);
  }
  if (char === '$' && rules.postgresStrings) {
    const tag = DOLLAR_QUOTE_TAG.exec(sql.slice(start))?.[0];
    if (tag) {
      const close = sql.indexOf(tag, start + tag.length);
      return close === -1 ? sql.length : close + tag.length;
    }
  }
  return start;
}

/** The index after the quote that closes the one at `start`; a doubled quote is an escaped one. */
function closingQuote(sql: string, start: number, backslashEscapes: boolean): number {
  const quote = sql[start];
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (backslashEscapes && char === '\\') {
      index += 2;
    } else if (char === quote && sql[index + 1] === quote) {
      index += 2;
    } else if (char === quote) {
      return index + 1;
    } else {
      index++;
    }
  }
  return sql.length;
}

/** PostgreSQL `E'...'`: the E stands alone, not at the end of an identifier such as `type'`. */
function isEscapeStringPrefix(sql: string, quoteIndex: number): boolean {
  const prefix = sql[quoteIndex - 1];
  return (prefix === 'E' || prefix === 'e') && !WORD_CHAR.test(sql[quoteIndex - 2] ?? '');
}
