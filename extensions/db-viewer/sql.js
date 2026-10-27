// SQL text in the editor: tokens for highlighting, and the statement under the cursor.

const KEYWORDS = new Set(
  `ADD ALL ALTER ANALYZE AND AS ASC AUTO_INCREMENT BETWEEN BIGINT BINARY BLOB BOOLEAN BY CASE CAST CHANGE CHAR CHARSET
  CHECK COLLATE COLUMN COLUMNS COMMENT CONSTRAINT CREATE CROSS CURRENT_DATE CURRENT_TIMESTAMP DATABASE DATABASES DATE
  DATETIME DECIMAL DEFAULT DELETE DESC DESCRIBE DISTINCT DIV DO DOUBLE DROP DUPLICATE ELSE END ENGINE ENUM ESCAPE
  EXISTS EXPLAIN FALSE FLOAT FOR FOREIGN FORMAT FROM FULL FULLTEXT FUNCTION GRANT GROUP HAVING IF IGNORE IN INDEX INNER
  INSERT INT INTEGER INTERVAL INTO IS JOIN JSON KEY KEYS KILL LATERAL LEFT LIKE LIMIT LOCK MODIFY NATURAL NOT NULL
  OFFSET ON OR ORDER OUTER OVER PARTITION PRIMARY PROCEDURE PROCESSLIST RECURSIVE REFERENCES REGEXP RENAME REPLACE
  RIGHT ROLLUP ROW ROWS SCHEMA SCHEMAS SELECT SET SHARE SHOW SMALLINT STATUS STRAIGHT_JOIN TABLE TABLES TEMPORARY TEXT
  THEN TIME TIMESTAMP TINYINT TO TRIGGER TRUE TRUNCATE UNION UNIQUE UNSIGNED UPDATE USE USING VALUES VARCHAR VARIABLES
  VIEW WHEN WHERE WINDOW WITH XOR`.split(/\s+/),
);

/** Tokens of the whole text: [{type, text}], types: kw, str, num, com, ident (backticked), var, op, word, ws. */
export function tokenize(sql) {
  const out = [];
  let i = 0;
  const n = sql.length;
  const push = (type, end) => {
    out.push({ type, text: sql.slice(i, end) });
    i = end;
  };
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n && sql[j] !== c) j += sql[j] === "\\" && c !== "`" ? 2 : 1;
      push(c === "`" ? "ident" : "str", Math.min(n, j + 1));
    } else if (c === "#" || (c === "-" && sql[i + 1] === "-")) {
      const j = sql.indexOf("\n", i);
      push("com", j < 0 ? n : j);
    } else if (c === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      push("com", j < 0 ? n : j + 2);
    } else if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(sql[j])) j++;
      push("ws", j);
    } else if (/[0-9]/.test(c)) {
      const m = /^(0x[0-9a-f]+|\d+(\.\d+)?(e[+-]?\d+)?)/i.exec(sql.slice(i, i + 64));
      push("num", i + (m ? m[0].length : 1));
    } else if (c === "@") {
      const m = /^@@?[\w.$]*/.exec(sql.slice(i, i + 128));
      push("var", i + m[0].length);
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(sql[j])) j++;
      push(KEYWORDS.has(sql.slice(i, j).toUpperCase()) ? "kw" : "word", j);
    } else {
      push("op", i + 1);
    }
  }
  return out;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function highlight(sql) {
  return tokenize(sql)
    .map((t) => (t.type === "ws" || t.type === "op" || t.type === "word" ? esc(t.text) : `<span class="t-${t.type}">${esc(t.text)}</span>`))
    .join("");
}

/** The statements of the text with their ranges: [{start, end, text}] (separated by top-level semicolons). */
export function statements(sql) {
  const out = [];
  let start = 0;
  let pos = 0;
  for (const t of tokenize(sql)) {
    pos += t.text.length;
    if (t.type === "op" && t.text === ";") {
      out.push({ start, end: pos - 1, text: sql.slice(start, pos - 1) });
      start = pos;
    }
  }
  out.push({ start, end: sql.length, text: sql.slice(start) });
  return out.filter((s) => s.text.replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, "").trim());
}

/** The statement the cursor is in (or right after). */
export function statementAt(sql, cursor) {
  const list = statements(sql);
  if (!list.length) return null;
  let best = list[0];
  for (const s of list) if (s.start <= cursor) best = s;
  // The cursor after the last semicolon on a blank line belongs to the statement before it.
  return best;
}

export function quoteIdent(name) {
  return "`" + String(name).replace(/`/g, "``") + "`";
}
