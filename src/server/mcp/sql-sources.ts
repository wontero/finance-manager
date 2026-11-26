import { readonlyViewNames } from "../readonly-views.js";

type Token = string | Token[];

function denied(): never {
  throw new Error(
    "La consulta requiere permisos de solo lectura sobre las vistas autorizadas.",
  );
}

const views = new Set(readonlyViewNames);
const endOfFrom = new Set([
  "where",
  "group",
  "having",
  "order",
  "limit",
  "union",
  "except",
  "intersect",
]);

function identifier(token: Token | undefined) {
  if (typeof token !== "string") return undefined;
  if (token.startsWith("`")) return token.slice(1, -1).replaceAll("``", "`");
  if (/^[a-z_$][a-z_0-9$]*$/i.test(token)) return token;
  return undefined;
}

function keyword(token: Token | undefined) {
  return typeof token === "string" ? token.toLowerCase() : "";
}

function queryGroup(tokens: Token[]) {
  return (
    ["select", "with", "values"].includes(keyword(tokens[0])) ||
    (Array.isArray(tokens[0]) &&
      tokens.some((token) =>
        ["union", "except", "intersect"].includes(keyword(token)),
      ))
  );
}

function subqueries(tokens: Token[], ctes: ReadonlySet<string>) {
  for (const token of tokens) {
    if (!Array.isArray(token)) continue;
    if (queryGroup(token)) query(token, ctes);
    else subqueries(token, ctes);
  }
}

function sources(
  tokens: Token[],
  ctes: ReadonlySet<string>,
  tableList = false,
) {
  function tableAt(index: number) {
    const token = tokens[index];
    if (tokens[index + 1] === "." || Array.isArray(tokens[index + 1])) denied();
    if (Array.isArray(token)) {
      if (queryGroup(token)) query(token, ctes);
      else sources(token, ctes, true);
    } else {
      const name = identifier(token);
      if (!name || (!views.has(name) && !ctes.has(name))) denied();
    }
  }

  let inFrom = tableList;
  if (tableList) tableAt(0);
  for (let i = tableList ? 1 : 0; i < tokens.length; i++) {
    const token = keyword(tokens[i]);
    if (
      ["from", "join", "straight_join"].includes(token) ||
      (inFrom && token === ",")
    ) {
      inFrom = true;
      tableAt(++i);
    } else if (
      endOfFrom.has(token) ||
      (token === "window" && keyword(tokens[i + 2]) === "as")
    ) {
      inFrom = false;
    } else {
      subqueries([tokens[i]], ctes);
    }
  }
}

function query(tokens: Token[], inherited: ReadonlySet<string>) {
  let i = 0;
  const ctes = new Set(inherited);
  if (keyword(tokens[i]) === "with") {
    do {
      const name = identifier(tokens[++i]);
      if (!name || keyword(tokens[i]) === "recursive") denied();
      i++;
      if (Array.isArray(tokens[i])) i++;
      if (keyword(tokens[i++]) !== "as") denied();
      const body = tokens[i++];
      if (!Array.isArray(body)) denied();
      query(body, ctes);
      ctes.add(name);
    } while (tokens[i] === ",");
  }
  const body = tokens.slice(i);
  if (!queryGroup(body)) denied();
  sources(body, ctes);
}

export function validateSources(statement: string, schemas: readonly string[]) {
  const schemaNames = new Set([
    ...schemas.map((name) => name.toLowerCase()),
    "information_schema",
    "mysql",
    "performance_schema",
    "sys",
  ]);
  const blocked = new Set([
    "set",
    "into",
    "table",
    "for",
    "lock",
    "procedure",
    "get_lock",
    "release_lock",
    "release_all_locks",
    "is_used_lock",
    "is_free_lock",
    "load_file",
  ]);
  const words =
    /'(?:\\[\s\S]|''|[^'\\])*'|"(?:\\[\s\S]|""|[^"\\])*"|\x60(?:\x60\x60|[^\x60])*\x60|[a-z_0-9$]+|[^ \t-\r]/gi;
  const tokens: Token[] = [];
  const stack = [tokens];
  for (const [token] of statement.matchAll(words)) {
    const current = stack.at(-1)!;
    const name = (identifier(token) ?? token).toLowerCase();
    if (
      schemaNames.has(name) ||
      blocked.has(name) ||
      /^[@{}\\'"`\x00-\x1f\x7f-\uffff]$/u.test(token) ||
      (["'", '"'].includes(token[0]) &&
        schemaNames.has(token.slice(1, -1).trim().toLowerCase()))
    )
      denied();
    if (token === "(") {
      if (stack.length === 128) denied();
      const group: Token[] = [];
      current.push(group);
      stack.push(group);
    } else if (token === ")") {
      if (stack.length === 1) denied();
      stack.pop();
    } else {
      current.push(token);
    }
  }
  if (stack.length !== 1) denied();
  query(tokens, new Set());
}
