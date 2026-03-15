import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

import { requireEnv } from "@/lib/server/env";

type AllowedOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "in"
  | "contains"
  | "not_contains";

type FilterValue = string | number | boolean | string[];

export type QueryFilter = {
  col: string;
  op: AllowedOp;
  val: FilterValue;
};

export type QueryPlan = {
  table: "pokemon_data";
  select?: string;
  filters?: QueryFilter[];
  order?: Array<{
    col: string;
    ascending?: boolean;
  }>;
  limit?: number;
};

type SearchCriteria = {
  types: string[];
  moves: string[];
  abilities: string[];
  exclude_types: string[];
  exclude_moves: string[];
  exclude_abilities: string[];
};

const ALLOWED_TABLES = new Set(["pokemon_data"]);
const ALLOWED_COLUMNS: Record<string, Set<string>> = {
  pokemon_data: new Set(["name", "types", "moves", "abilities"]),
};
const MAX_LIMIT = 2000;
const MAX_TYPES = 2;
const MAX_MOVES = 4;
const MAX_ABILITIES = 1;

function getSupabaseClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_KEY"));
}

function createBaseQuery(table: string, select: string) {
  return getSupabaseClient().from(table).select(select);
}

type QueryBuilder = ReturnType<typeof createBaseQuery>;

function getCerebrasModel() {
  return process.env.CEREBRAS_MODEL ?? "gpt-oss-120b";
}

function getCerebrasClient() {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) {
    return null;
  }

  return new OpenAI({
    baseURL: "https://api.cerebras.ai/v1",
    apiKey,
  });
}

function ensureAllowedColumn(table: string, column: string) {
  if (!ALLOWED_COLUMNS[table]?.has(column)) {
    throw new Error(`Disallowed column: ${table}.${column}`);
  }
}

function toPostgresTextArrayLiteral(values: string[]): string {
  const escaped = values.map((value) => `"${value.replaceAll(/["\\]/g, "\\$&")}"`);
  return `{${escaped.join(",")}}`;
}

function normalizeList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const cleaned = item.trim().toLowerCase();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    out.push(cleaned);

    if (out.length >= maxItems) {
      break;
    }
  }

  return out;
}

function applyFilter(query: QueryBuilder, table: string, filter: QueryFilter) {
  const { col, op, val } = filter;
  ensureAllowedColumn(table, col);

  switch (op) {
    case "eq":
      return query.eq(col, val);
    case "neq":
      return query.neq(col, val);
    case "gt":
      return query.gt(col, val);
    case "gte":
      return query.gte(col, val);
    case "lt":
      return query.lt(col, val);
    case "lte":
      return query.lte(col, val);
    case "like":
      return query.like(col, String(val));
    case "ilike":
      return query.ilike(col, String(val));
    case "in":
      if (!Array.isArray(val)) {
        throw new Error("in operator requires a list");
      }
      return query.in(col, val);
    case "contains":
      if (!Array.isArray(val)) {
        throw new Error("contains operator requires a list");
      }
      return query.contains(col, val);
    case "not_contains":
      if (!Array.isArray(val)) {
        throw new Error("not_contains operator requires a list");
      }
      return query.not(col, "cs", toPostgresTextArrayLiteral(val));
    default:
      throw new Error(`Unsupported op: ${op satisfies never}`);
  }
}

export async function executeSupabasePlan(plan: QueryPlan): Promise<Record<string, unknown>[]> {
  const { table } = plan;
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Disallowed table: ${table}`);
  }

  const select = plan.select ?? "*";
  const limit = Math.min(Math.max(plan.limit ?? 100, 1), MAX_LIMIT);

  let query = createBaseQuery(table, select);

  for (const filter of plan.filters ?? []) {
    query = applyFilter(query, table, filter);
  }

  for (const order of plan.order ?? []) {
    ensureAllowedColumn(table, order.col);
    query = query.order(order.col, { ascending: order.ascending ?? true });
  }

  const { data, error } = await query.limit(limit);
  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as unknown as Record<string, unknown>[];
}

export async function extractCriteriaFromText(query: string): Promise<SearchCriteria> {
  const cerebrasClient = getCerebrasClient();
  if (!cerebrasClient) {
    throw new Error("Missing CEREBRAS_API_KEY");
  }

  const system = [
    "You extract search criteria for Pokemon and return only JSON.",
    'Return only JSON with keys "types", "moves", "abilities", "exclude_types", "exclude_moves", "exclude_abilities", "notes".',
    "Values must be arrays of lowercase strings.",
    "Do not add any keys outside that schema.",
    "Only include items explicitly requested by the user.",
    "Correct spelling and spacing to canonical move/ability/type names.",
    "Do not copy the terms directly.",
    "Confirm each is a real type/move/ability and is spelled and spaced correctly.",
    "If a user token appears to be concatenated, split it into the intended multi-word term.",
    "If truly ambiguous, or if they are requesting unknown criteria, it may not be in your training data; use your best judgement for what the user meant.",
    "Also in the notes attribute write down any editing you had to make to the query, how and why.",
  ].join(" ");

  const response = await cerebrasClient.chat.completions.create({
    model: getCerebrasModel(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Query: ${query}` },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  const data = JSON.parse(content) as Record<string, unknown>;

  return {
    types: normalizeList(data.types, MAX_TYPES),
    moves: normalizeList(data.moves, MAX_MOVES),
    abilities: normalizeList(data.abilities, MAX_ABILITIES),
    exclude_types: normalizeList(data.exclude_types, MAX_TYPES),
    exclude_moves: normalizeList(data.exclude_moves, MAX_MOVES),
    exclude_abilities: normalizeList(data.exclude_abilities, MAX_ABILITIES),
  };
}

export function buildPlanFromCriteria(criteria: SearchCriteria): QueryPlan {
  const filters: QueryFilter[] = [];

  if (criteria.types.length > 0) {
    filters.push({ col: "types", op: "contains", val: criteria.types });
  }
  if (criteria.moves.length > 0) {
    filters.push({ col: "moves", op: "contains", val: criteria.moves });
  }
  if (criteria.abilities.length > 0) {
    filters.push({ col: "abilities", op: "contains", val: criteria.abilities });
  }
  if (criteria.exclude_types.length > 0) {
    filters.push({ col: "types", op: "not_contains", val: criteria.exclude_types });
  }
  if (criteria.exclude_moves.length > 0) {
    filters.push({ col: "moves", op: "not_contains", val: criteria.exclude_moves });
  }
  if (criteria.exclude_abilities.length > 0) {
    filters.push({
      col: "abilities",
      op: "not_contains",
      val: criteria.exclude_abilities,
    });
  }

  return {
    table: "pokemon_data",
    select: "name",
    filters,
    limit: 200,
  };
}

export async function answerInEnglish(
  criteria: SearchCriteria,
  results: string[],
): Promise<string> {
  const cerebrasClient = getCerebrasClient();
  if (!cerebrasClient) {
    throw new Error("Missing CEREBRAS_API_KEY");
  }

  const system = [
    "You are given a list of pokemon names along with criteria that they all fulfill.",
    "Criteria will include 6 lists of types, moves, abilities, as well as exclusions of those.",
    "For each of these lists that aren't empty, please declare in plain English that the pokemon (capitalized names) that meet these criteria are the list.",
    "For example, '<type> Pokemon that know <move_1> and <move_2> and have <ability> are <pokemon_1>, <pokemon_2>, and <pokemon_3>'.",
    "For a single pokemon output, 'The <type> Pokemon that knows <move_1> and <move_2> and has <ability> is <pokemon>'.",
    "Capitalize the criteria, and make sure to always include them in your output as previously formatted for triaging.",
    "Finally, some pokemon have special names with hyphens.",
    "If the pokemon is a mega pokemon, call it 'Mega <pokemon_name>'.",
    "<pokemon_name>-'mega-x' becomes 'Mega <pokemon_name> X'.",
    "<pokemon_name>-'mega-y' becomes 'Mega <pokemon_name> Y'.",
    "If the pokemon is a regional form, please state the region first as an adjective using these exact mappings:",
    "<pokemon_name>-'alola' -> Alolan <pokemon_name>.",
    "<pokemon_name>-'galar' -> Galarian <pokemon_name>.",
    "<pokemon_name>-'paldea' -> Paldean <pokemon_name>.",
    "<pokemon_name>-'hisui' -> Hisuian <pokemon_name>.",
    "The database may return duplicates of the same species in different forms or genders.",
    "If there are species duplicates that are not regional form differences, include only one copy of the species name and exclude the other form data.",
    "Regional information should never be excluded.",
    "If there are multiple names that have the same first word, then those are duplicates. Confirm this does not happen in your output.",
    "Confirm there are no hyphens and regions come before the species name, but do not add regional or mega information that was not already present.",
    "Return exactly one sentence and use correct grammar.",
  ].join(" ");

  const response = await cerebrasClient.chat.completions.create({
    model: getCerebrasModel(),
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `Criteria: ${JSON.stringify(criteria)}, Results: ${JSON.stringify(results)}`,
      },
    ],
  });

  return (response.choices[0]?.message?.content ?? "")
    .replaceAll("\u202F", " ")
    .replaceAll("\u00A0", " ")
    .replaceAll("\u2009", " ");
}
