import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireEnv } from "@/lib/server/env";

export type QueryFilter = {
  col: "types" | "moves" | "abilities";
  op: "contains" | "not_contains";
  val: string;
};

export type QueryPlan = {
  table: "pokemon_data";
  select: "name";
  filters: QueryFilter[];
};

const QueryFilterSchema = z.object({
  col: z.enum(["types", "moves", "abilities"]),
  op: z.enum(["contains", "not_contains"]),
  val: z.string(),
});

const QueryPlanSchema = z.object({
  table: z.literal("pokemon_data"),
  select: z.literal("name"),
  filters: z.array(QueryFilterSchema).max(7),
});

const ModelPlanSchema = z.object({
  filters: z.array(QueryFilterSchema).max(7),
  notes: z.array(z.string()),
});

const CEREBRAS_MODEL_PLAN_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "pokemon_query_plan",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        filters: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              col: {
                type: "string",
                enum: ["types", "moves", "abilities"],
              },
              op: {
                type: "string",
                enum: ["contains", "not_contains"],
              },
              val: {
                type: "string",
              },
            },
            required: ["col", "op", "val"],
          },
        },
        notes: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
      required: ["filters", "notes"],
    },
  },
};

const ALLOWED_TABLES = new Set(["pokemon_data"]);
const ALLOWED_COLUMNS: Record<string, Set<string>> = {
  pokemon_data: new Set(["name", "types", "moves", "abilities"]),
};
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

function normalizePlan(plan: QueryPlan): QueryPlan {
  const limitByColumn = {
    types: MAX_TYPES,
    moves: MAX_MOVES,
    abilities: MAX_ABILITIES,
  } as const;
  const counts = {
    types: 0,
    moves: 0,
    abilities: 0,
  };
  const seen = new Set<string>();
  const normalizedFilters: QueryFilter[] = [];

  for (const filter of plan.filters) {
    const values = normalizeList([filter.val], limitByColumn[filter.col]);
    for (const value of values) {
      if (counts[filter.col] >= limitByColumn[filter.col]) {
        break;
      }

      const key = `${filter.col}:${filter.op}:${value}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      counts[filter.col] += 1;
      normalizedFilters.push({
        col: filter.col,
        op: filter.op,
        val: value,
      });
    }
  }

  return {
    table: "pokemon_data",
    select: "name",
    filters: normalizedFilters,
  };
}

function applyFilter(query: QueryBuilder, table: string, filter: QueryFilter) {
  const { col, op, val } = filter;
  ensureAllowedColumn(table, col);

  switch (op) {
    case "contains":
      return query.contains(col, [val]);
    case "not_contains":
      return query.not(col, "cs", toPostgresTextArrayLiteral([val]));
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

  let query = createBaseQuery(table, select);

  for (const filter of plan.filters) {
    query = applyFilter(query, table, filter);
  }
  const { data, error } = await query;
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
    'Return only the keys "filters" and "notes".',
    'Allowed filter columns: "types", "moves", "abilities".',
    'Allowed filter operators: "contains", "not_contains".',
    'Use an empty array for "filters" when there are none.',
    "Each filter value must be a canonical lowercase string.",
    "Only include filters explicitly requested by the user.",
    "Correct spelling and spacing to canonical move, ability, and type names.",
    "Do not copy misspelled or malformed terms directly into the output.",
    "Confirm each extracted term is a real type, move, or ability and is spelled and spaced correctly.",
    "If a user token appears concatenated, split it into the intended multi-word term.",
    "If a term is ambiguous or uncommon, use your best judgment to map it to the intended canonical Pokemon term.",
    "For example, raindance -> rain dance",
    "Also in the notes attribute write down any editing you had to make to the query, how and why.",
    "Do not add extra keys or explanations.",
  ].join(" ");

  const response = await cerebrasClient.chat.completions.create({
    model: getCerebrasModel(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Query: ${query}` },
    ],
    response_format: CEREBRAS_MODEL_PLAN_RESPONSE_FORMAT,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Model did not return structured output content");
  }
  const parsed = ModelPlanSchema.parse(JSON.parse(content));
  console.log("[planFromText] notes", parsed.notes);

  return normalizePlan({
    table: "pokemon_data",
    select: "name",
    filters: parsed.filters,
  });
}

function titleCasePokemonTerm(value: string): string {
  return value
    .split(/[\s-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function joinWithAnd(values: string[]): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    return values[0];
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
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
