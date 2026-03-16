import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireEnv } from "@/lib/server/env";

export type QueryFilter = {
  col: "types" | "moves" | "abilities";
  op: "contains" | "not_contains";
  val: string[];
};

export type QueryPlan = {
  table: "pokemon_data";
  select: "name";
  filters: QueryFilter[];
  order: Array<{
    col: "name" | "types" | "moves" | "abilities";
    ascending: boolean;
  }>;
  limit: number;
};

const QueryFilterSchema = z.object({
  col: z.enum(["types", "moves", "abilities"]),
  op: z.enum(["contains", "not_contains"]),
  val: z.array(z.string()),
});

const QueryPlanSchema = z.object({
  table: z.literal("pokemon_data"),
  select: z.literal("name"),
  filters: z.array(QueryFilterSchema).max(6),
  order: z
    .array(
      z.object({
        col: z.enum(["name", "types", "moves", "abilities"]),
        ascending: z.boolean(),
      }),
    ),
  limit: z.number().int().min(1).max(200),
});

const ModelPlanSchema = z.object({
  filters: z.array(QueryFilterSchema).max(6),
  order: z
    .array(
      z.object({
        col: z.enum(["name", "types", "moves", "abilities"]),
        ascending: z.boolean(),
      }),
    ),
  limit: z.number().int().min(1).max(200),
});

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

function coerceFilter(raw: unknown): QueryFilter | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const rawCol = record.col ?? record.column ?? record.field ?? record.attribute;
  const rawOp = record.op ?? record.operator ?? record.comparison;
  const rawVal = record.val ?? record.value ?? record.values;

  const colAliases: Record<string, QueryFilter["col"]> = {
    type: "types",
    types: "types",
    move: "moves",
    moves: "moves",
    ability: "abilities",
    abilities: "abilities",
  };

  const opAliases: Record<string, QueryFilter["op"]> = {
    contains: "contains",
    include: "contains",
    includes: "contains",
    has: "contains",
    is: "contains",
    equals: "contains",
    not_contains: "not_contains",
    excludes: "not_contains",
    exclude: "not_contains",
    not_has: "not_contains",
    not: "not_contains",
    "!=": "not_contains",
  };

  if (typeof rawCol !== "string" || typeof rawOp !== "string") {
    return null;
  }

  const col = colAliases[rawCol.trim().toLowerCase()];
  const op = opAliases[rawOp.trim().toLowerCase()];
  if (!col || !op) {
    return null;
  }

  const maxItems = col === "types" ? MAX_TYPES : col === "moves" ? MAX_MOVES : MAX_ABILITIES;
  const val = Array.isArray(rawVal)
    ? normalizeList(rawVal, maxItems)
    : typeof rawVal === "string"
      ? normalizeList([rawVal], maxItems)
      : [];

  if (val.length === 0) {
    return null;
  }

  return { col, op, val };
}

function coercePlan(raw: unknown): QueryPlan {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawFilters = Array.isArray(record.filters) ? record.filters : [];
  const rawOrder = Array.isArray(record.order) ? record.order : [];
  const rawLimit = record.limit;
  const limit =
    typeof rawLimit === "number"
      ? rawLimit
      : typeof rawLimit === "string" && Number.isFinite(Number(rawLimit))
        ? Number(rawLimit)
        : 200;

  return {
    table: "pokemon_data",
    select: "name",
    filters: rawFilters.map(coerceFilter).filter((filter): filter is QueryFilter => filter !== null),
    order: rawOrder
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const record = item as Record<string, unknown>;
        const col = record.col;
        const ascending = record.ascending;
        if (
          (col === "name" || col === "types" || col === "moves" || col === "abilities") &&
          typeof ascending === "boolean"
        ) {
          return { col, ascending };
        }
        return null;
      })
      .filter(
        (
          item,
        ): item is {
          col: "name" | "types" | "moves" | "abilities";
          ascending: boolean;
        } => item !== null,
      ),
    limit,
  };
}

function normalizePlan(plan: QueryPlan): QueryPlan {
  const normalizedFilters = plan.filters
    .map((filter) => ({
      col: filter.col,
      op: filter.op,
      val: normalizeList(
        filter.val,
        filter.col === "types"
          ? MAX_TYPES
          : filter.col === "moves"
            ? MAX_MOVES
            : MAX_ABILITIES,
      ),
    }))
    .filter((filter) => filter.val.length > 0);

  return {
    table: "pokemon_data",
    select: "name",
    filters: normalizedFilters,
    order: plan.order,
    limit: Math.min(Math.max(plan.limit, 1), 200),
  };
}

function applyFilter(query: QueryBuilder, table: string, filter: QueryFilter) {
  const { col, op, val } = filter;
  ensureAllowedColumn(table, col);

  switch (op) {
    case "contains":
      return query.contains(col, val);
    case "not_contains":
      return query.not(col, "cs", toPostgresTextArrayLiteral(val));
    default:
      throw new Error(`Unsupported op: ${op satisfies never}`);
  }
}

export async function executeSupabasePlan(plan: QueryPlan): Promise<Record<string, unknown>[]> {
  plan = QueryPlanSchema.parse(plan);
  const { table } = plan;
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Disallowed table: ${table}`);
  }

  const select = plan.select;
  const limit = Math.min(Math.max(plan.limit, 1), MAX_LIMIT);

  let query = createBaseQuery(table, select);

  for (const filter of plan.filters) {
    query = applyFilter(query, table, filter);
  }

  for (const order of plan.order) {
    ensureAllowedColumn(table, order.col);
    query = query.order(order.col, { ascending: order.ascending });
  }

  const { data, error } = await query.limit(limit);
  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as unknown as Record<string, unknown>[];
}

export async function planFromText(query: string): Promise<QueryPlan> {
  const cerebrasClient = getCerebrasClient();
  if (!cerebrasClient) {
    throw new Error("Missing CEREBRAS_API_KEY");
  }

  const system = [
    "Convert the user request into a Pokemon query plan and return only JSON.",
    'Return only the keys "filters", "order", and "limit".',
    'Allowed filter columns: "types", "moves", "abilities".',
    'Allowed filter operators: "contains", "not_contains".',
    'Use an empty array for "filters" or "order" when there are none.',
    "Each filter value must be an array of canonical lowercase strings.",
    "Only include filters explicitly requested by the user.",
    "Correct spelling and spacing to canonical move, ability, and type names.",
    "Do not copy misspelled or malformed terms directly into the output.",
    "Confirm each extracted term is a real type, move, or ability and is spelled and spaced correctly.",
    "If a user token appears concatenated, split it into the intended multi-word term.",
    "If a term is ambiguous or uncommon, use your best judgment to map it to the intended canonical Pokemon term.",
    "Do not add extra keys or explanations.",
  ].join(" ");

  try {
    const response = await cerebrasClient.chat.completions.parse({
      model: getCerebrasModel(),
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Query: ${query}` },
      ],
      response_format: zodResponseFormat(ModelPlanSchema, "pokemon_query_plan"),
    });

    const parsed = response.choices[0]?.message.parsed;
    if (!parsed) {
      throw new Error("Model did not return a parsed query plan");
    }

    return normalizePlan({
      table: "pokemon_data",
      select: "name",
      filters: parsed.filters,
      order: parsed.order,
      limit: parsed.limit,
    });
  } catch (error) {
    const response = await cerebrasClient.chat.completions.create({
      model: getCerebrasModel(),
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Query: ${query}` },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw error;
    }

    const parsed = QueryPlanSchema.parse(coercePlan(JSON.parse(content)));
    return normalizePlan(parsed);
  }
}

export async function answerInEnglish(
  plan: QueryPlan,
  results: string[],
): Promise<string> {
  const cerebrasClient = getCerebrasClient();
  if (!cerebrasClient) {
    throw new Error("Missing CEREBRAS_API_KEY");
  }

  const system = [
    "You are given a list of pokemon names along with criteria that they all fulfill.",
    "Criteria will be provided as filters over types, moves, and abilities, including exclusions.",
    "Describe the filters in plain English before listing the Pokemon names.",
    "For example, '<type> Pokemon that know <move_1> and <move_2> and have <ability> are <pokemon_1>, <pokemon_2>, and <pokemon_3>'.",
    "For a single pokemon output, 'The <type> Pokemon that knows <move_1> and <move_2> and has <ability> is <pokemon>'.",
    "Capitalize type, move, and ability names in the sentence.",
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
        content: `Filters: ${JSON.stringify(plan.filters ?? [])}, Results: ${JSON.stringify(results)}`,
      },
    ],
  });

  return (response.choices[0]?.message?.content ?? "")
    .replaceAll("\u202F", " ")
    .replaceAll("\u00A0", " ")
    .replaceAll("\u2009", " ");
}
