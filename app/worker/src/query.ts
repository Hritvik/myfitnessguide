/**
 * Guarding `query`: read-only SQL over the curated `v_*` views only.
 *
 * D1 has no authorizer hook, so the SQL is tokenized (strings, quoted
 * identifiers and comments handled) and checked structurally: one
 * statement, starting with SELECT or WITH, no write or schema keywords, no
 * recursive CTE, and every name in a FROM / JOIN list a `v_*` view or a CTE
 * of the query. CTEs may not shadow a real table or view. The query then
 * runs wrapped in an outer SELECT with a LIMIT.
 */

export type Token = { kind: "word" | "quoted" | "string" | "number" | "param" | "punct"; text: string };

export class QueryRefused extends Error {}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new QueryRefused("unterminated comment");
      i = end + 2;
    } else if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new QueryRefused("unterminated string");
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      tokens.push({ kind: "string", text: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      let text = "";
      for (;;) {
        if (j >= sql.length) throw new QueryRefused("unterminated identifier");
        if (sql[j] === close && close !== "]" && sql[j + 1] === close) {
          text += close;
          j += 2;
        } else if (sql[j] === close) break;
        else text += sql[j++];
      }
      tokens.push({ kind: "quoted", text });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j] as string)) j++;
      tokens.push({ kind: "word", text: sql.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      let j = i;
      while (j < sql.length && /[0-9A-Za-z_.]/.test(sql[j] as string)) j++;
      tokens.push({ kind: "number", text: sql.slice(i, j) });
      i = j;
    } else if (c === "?" || c === ":" || c === "@" || c === "$") {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j] as string)) j++;
      tokens.push({ kind: "param", text: sql.slice(i, j) });
      i = j;
    } else {
      const two = sql.slice(i, i + 2);
      if (["<=", ">=", "<>", "!=", "==", "||", "<<", ">>", "->"].includes(two)) {
        tokens.push({ kind: "punct", text: sql[i + 2] === ">" && two === "->" ? "->>" : two });
        i += sql[i + 2] === ">" && two === "->" ? 3 : 2;
      } else {
        tokens.push({ kind: "punct", text: c });
        i++;
      }
    }
  }
  return tokens;
}

const FORBIDDEN = new Set([
  "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "ATTACH", "DETACH", "PRAGMA", "VACUUM", "REINDEX", "ANALYZE",
  "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "RECURSIVE", "TRIGGER", "INDEX",
]);
const ENDS_FROM = new Set(["WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "WINDOW", "UNION", "EXCEPT", "INTERSECT", "RETURNING"]);

export interface Checked {
  /** The query without a trailing semicolon. */
  sql: string;
  views: string[];
}

/**
 * Check a query against the rules; returns the views it reads. `views` and
 * `tables` are the database's view and table names (lower case).
 */
export function checkQuery(sql: string, views: ReadonlySet<string>, tables: ReadonlySet<string>): Checked {
  const tokens = tokenize(sql);
  let body = sql.trim();
  if (tokens.at(-1)?.text === ";") {
    tokens.pop();
    body = body.replace(/;\s*$/, "");
  }
  if (tokens.length === 0) throw new QueryRefused("the query is empty");
  if (tokens.some((t) => t.kind === "punct" && t.text === ";")) throw new QueryRefused("only a single statement is allowed");
  const word = (t: Token | undefined) => (t?.kind === "word" ? t.text.toUpperCase() : null);
  const head = word(tokens[0]);
  if (head !== "SELECT" && head !== "WITH") throw new QueryRefused("only SELECT queries are allowed");

  for (const [i, t] of tokens.entries()) {
    const w = word(t);
    if (w && FORBIDDEN.has(w)) throw new QueryRefused(`${w} is not allowed in a read-only query`);
    if (w === "REPLACE" && tokens[i + 1]?.text !== "(") throw new QueryRefused("REPLACE is not allowed in a read-only query");
  }

  // CTE names: ident [ ( cols ) ] AS (
  const ctes = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind !== "word" && t.kind !== "quoted") continue;
    let j = i + 1;
    if (tokens[j]?.text === "(" && (word(tokens[i - 1]) === "WITH" || tokens[i - 1]?.text === ",")) {
      let depth = 0;
      for (; j < tokens.length; j++) {
        if (tokens[j]?.text === "(") depth++;
        if (tokens[j]?.text === ")" && --depth === 0) break;
      }
      j++;
    }
    if (word(tokens[j]) === "AS" && tokens[j + 1]?.text === "(" && (word(tokens[i - 1]) === "WITH" || tokens[i - 1]?.text === ",")) {
      const name = t.text.toLowerCase();
      if (tables.has(name) || views.has(name)) throw new QueryRefused(`a CTE may not be named like the table or view ${name}`);
      ctes.add(name);
    }
  }

  // Every source in a FROM or JOIN list must be a view or a CTE.
  const used = new Set<string>();
  const inFrom: boolean[] = [];
  let depth = 0;
  let expectSource = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    const w = word(t);
    if (expectSource) {
      expectSource = false;
      if (t.text === "(") {
        depth++;
        // SQLite reads `FROM (name)` and `FROM (a JOIN b ...)` as table references, not subqueries
        // (decision 138): only SELECT, WITH or VALUES open a subquery; anything else is still a source.
        const next = word(tokens[i + 1]);
        const subquery = next === "SELECT" || next === "WITH" || next === "VALUES";
        inFrom[depth] = !subquery;
        expectSource = !subquery;
        continue;
      }
      if (t.kind !== "word" && t.kind !== "quoted") throw new QueryRefused(`unexpected ${t.text} after FROM`);
      const name = t.text.toLowerCase();
      if (tokens[i + 1]?.text === ".") throw new QueryRefused(`schema-qualified names (${name}.${tokens[i + 2]?.text ?? ""}) are not allowed`);
      if (tokens[i + 1]?.text === "(") throw new QueryRefused(`table-valued functions (${name}) are not allowed`);
      if (ctes.has(name)) continue;
      if (!name.startsWith("v_") || !views.has(name)) {
        throw new QueryRefused(tables.has(name) ? `${name} is a table; query the v_* views instead` : `${name} is not a curated view`);
      }
      used.add(name);
      continue;
    }
    if (t.text === "(") {
      depth++;
      inFrom[depth] = false;
    } else if (t.text === ")") {
      inFrom[depth] = false;
      depth--;
    } else if (w === "FROM" && word(tokens[i - 1]) !== "DISTINCT") {
      inFrom[depth] = true;
      expectSource = true;
    } else if (w === "JOIN") {
      expectSource = true;
    } else if (t.text === "," && inFrom[depth]) {
      expectSource = true;
    } else if (w && ENDS_FROM.has(w)) {
      inFrom[depth] = false;
    }
  }
  if (expectSource) throw new QueryRefused("FROM needs a view");
  return { sql: body, views: [...used] };
}
