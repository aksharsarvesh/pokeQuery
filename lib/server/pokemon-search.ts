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

export type PokemonRow = {
  name: string | null;
};

const QueryFilterSchema = z.object({
  col: z.enum(["types", "moves", "abilities"]),
  op: z.enum(["contains", "not_contains"]),
  val: z.string(),
});

const QueryPlanSchema = z.object({
  table: z.literal("pokemon_data"),
  select: z.literal("name"),
  filters: z.array(QueryFilterSchema),
});

const ModelPlanSchema = z.object({
  filters: z.array(QueryFilterSchema),
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

const ALLOWED_TABLES = new Set<QueryPlan["table"]>(["pokemon_data"]);
const ALLOWED_COLUMNS: Record<QueryPlan["table"], Set<string>> = {
  pokemon_data: new Set(["name", "types", "moves", "abilities"]),
};
const UNBOUNDED_FILTERS = Number.POSITIVE_INFINITY;
const FILTER_LIMITS = {
  types: UNBOUNDED_FILTERS,
  moves: UNBOUNDED_FILTERS,
  abilities: UNBOUNDED_FILTERS,
} as const;
const supabaseClient = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_KEY"),
);
const cerebrasApiKey = process.env.CEREBRAS_API_KEY;
const cerebrasClient = cerebrasApiKey
  ? new OpenAI({
      baseURL: "https://api.cerebras.ai/v1",
      apiKey: cerebrasApiKey,
    })
  : null;

function createBaseQuery(table: QueryPlan["table"], select: QueryPlan["select"]) {
  return supabaseClient.from(table).select(select);
}

type QueryBuilder = ReturnType<typeof createBaseQuery>;

function getCerebrasModel() {
  return process.env.CEREBRAS_MODEL ?? "gpt-oss-120b";
}

function getCerebrasClient() {
  return cerebrasClient;
}

function ensureAllowedColumn(table: QueryPlan["table"], column: string) {
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
  const counts = {
    types: 0,
    moves: 0,
    abilities: 0,
  };
  const seen = new Set<string>();
  const normalizedFilters: QueryFilter[] = [];

  for (const filter of plan.filters) {
    const values = normalizeList([filter.val], FILTER_LIMITS[filter.col]);
    for (const value of values) {
      if (counts[filter.col] >= FILTER_LIMITS[filter.col]) {
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

function applyFilter(query: QueryBuilder, table: QueryPlan["table"], filter: QueryFilter) {
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

export async function executeSupabasePlan(plan: QueryPlan): Promise<PokemonRow[]> {
  const parsedPlan = QueryPlanSchema.parse(plan);
  const { table, select, filters } = parsedPlan;
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Disallowed table: ${table}`);
  }

  let query = createBaseQuery(table, select);

  for (const filter of filters) {
    query = applyFilter(query, table, filter);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as PokemonRow[];
}

export function extractPokemonNames(rows: PokemonRow[]): string[] {
  return rows
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
}

export async function searchPokemon(plan: QueryPlan): Promise<string[]> {
  const rows = await executeSupabasePlan(plan);
  return extractPokemonNames(rows);
}

export async function searchPokemonRowsAndNames(plan: QueryPlan): Promise<{
  results: string[];
}> {
  const rows = await executeSupabasePlan(plan);

  return {
    results: extractPokemonNames(rows),
  };
}

export async function searchPokemonFromText(query: string): Promise<{
  answer: string;
  plan: QueryPlan;
  results: string[];
}> {
  const plan = await planFromText(query);
  const { results } = await searchPokemonRowsAndNames(plan);

  return {
    answer: await answerInEnglish(plan, results),
    plan,
    results,
  };
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

const REGIONAL_FORM_PREFIX: Record<string, string> = {
  alola: "Alolan",
  galar: "Galarian",
  paldea: "Paldean",
  hisui: "Hisuian",
};

const SPACE_NORMALIZATION_PATTERN = /[\u202F\u00A0\u2009]/g;
const MEGA_X_SUFFIX = ["mega", "x"] as const;
const MEGA_Y_SUFFIX = ["mega", "y"] as const;
const MEGA_SUFFIX = ["mega"] as const;
const GENERIC_FORM_SUFFIXES = new Set(["standard"]);

type ParsedPokemonName = {
  displayName: string;
  speciesStem: string;
  regionalPrefix: string | null;
  collapsedDisplayName: string;
};

type GroupedPokemonResult = {
  count: number;
  displayName: string;
  collapsedDisplayName: string;
};

type FilterSummary = {
  positiveTypes: string[];
  negativeTypes: string[];
  positiveMoves: string[];
  negativeMoves: string[];
  positiveAbilities: string[];
  negativeAbilities: string[];
};

function splitPokemonName(rawName: string): string[] {
  return rawName
    .trim()
    .toLowerCase()
    .split("-")
    .filter(Boolean);
}

function isRegionalSuffix(part: string): part is keyof typeof REGIONAL_FORM_PREFIX {
  return part in REGIONAL_FORM_PREFIX;
}

function hasTrailingSuffix(parts: string[], suffix: readonly string[]): boolean {
  if (parts.length < suffix.length) {
    return false;
  }

  return suffix.every((part, index) => parts[parts.length - suffix.length + index] === part);
}

function stripTrailingSuffix(parts: string[], suffix: readonly string[]): string[] {
  return parts.slice(0, parts.length - suffix.length);
}

function formatDisplayName(regionalPrefix: string | null, baseName: string, megaPrefix = ""): string {
  return [regionalPrefix, `${megaPrefix}${baseName}`].filter(Boolean).join(" ");
}

function extractRegionalPrefix(parts: string[]): {
  parts: string[];
  regionalPrefix: string | null;
} {
  const regionalIndex = parts.findIndex((part, index) => {
    if (index === 0 || !isRegionalSuffix(part)) {
      return false;
    }

    // Regional forms are encoded as "<species>-<region>-...".
    return index === 1;
  });
  if (regionalIndex === -1) {
    return {
      parts,
      regionalPrefix: null,
    };
  }

  const regionalToken = parts[regionalIndex];
  return {
    parts: parts.filter((_, index) => index !== regionalIndex),
    regionalPrefix: REGIONAL_FORM_PREFIX[regionalToken],
  };
}

function stripGenericFormSuffix(parts: string[]): string[] {
  const trailingPart = parts.at(-1);
  if (!trailingPart || !GENERIC_FORM_SUFFIXES.has(trailingPart)) {
    return parts;
  }

  return parts.slice(0, -1);
}

function extractPokemonNameInfo(rawName: string): ParsedPokemonName {
  const originalParts = splitPokemonName(rawName);
  if (originalParts.length === 0) {
    return {
      displayName: "",
      speciesStem: "",
      regionalPrefix: null,
      collapsedDisplayName: "",
    };
  }

  const { regionalPrefix, parts: extractedParts } = extractRegionalPrefix([
    ...originalParts,
  ]);
  let parts = extractedParts;

  let megaPrefix = "";
  if (hasTrailingSuffix(parts, MEGA_X_SUFFIX)) {
    megaPrefix = "Mega ";
    parts = stripTrailingSuffix(parts, MEGA_X_SUFFIX);
    parts.push("x");
  } else if (hasTrailingSuffix(parts, MEGA_Y_SUFFIX)) {
    megaPrefix = "Mega ";
    parts = stripTrailingSuffix(parts, MEGA_Y_SUFFIX);
    parts.push("y");
  } else if (hasTrailingSuffix(parts, MEGA_SUFFIX)) {
    megaPrefix = "Mega ";
    parts = stripTrailingSuffix(parts, MEGA_SUFFIX);
  }

  parts = stripGenericFormSuffix(parts);

  const displayBase = titleCasePokemonTerm(parts.join(" "));
  const speciesStem = parts[0] ?? "";

  return {
    displayName: formatDisplayName(regionalPrefix, displayBase, megaPrefix),
    speciesStem,
    regionalPrefix,
    collapsedDisplayName: formatDisplayName(
      regionalPrefix,
      titleCasePokemonTerm(speciesStem),
    ),
  };
}

function dedupePokemonResults(results: string[]): string[] {
  const grouped = new Map<string, GroupedPokemonResult>();
  const orderedKeys: string[] = [];

  for (const rawName of results) {
    const info = extractPokemonNameInfo(rawName);
    if (!info.displayName || !info.speciesStem) {
      continue;
    }

    const groupKey = info.regionalPrefix
      ? `${info.regionalPrefix}:${info.speciesStem}`
      : info.speciesStem;

    const existing = grouped.get(groupKey);
    if (existing) {
      existing.count += 1;
      continue;
    }

    grouped.set(groupKey, {
      count: 1,
      displayName: info.displayName,
      collapsedDisplayName: info.collapsedDisplayName,
    });
    orderedKeys.push(groupKey);
  }

  const deduped: string[] = [];
  for (const key of orderedKeys) {
    const group = grouped.get(key);
    if (!group) {
      continue;
    }
    deduped.push(group.count > 1 ? group.collapsedDisplayName : group.displayName);
  }

  return deduped;
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

function summarizeFilters(filters: QueryFilter[]): FilterSummary {
  const summary: FilterSummary = {
    positiveTypes: [],
    negativeTypes: [],
    positiveMoves: [],
    negativeMoves: [],
    positiveAbilities: [],
    negativeAbilities: [],
  };

  for (const filter of filters) {
    const formattedValue = titleCasePokemonTerm(filter.val);
    if (filter.col === "types" && filter.op === "contains") {
      summary.positiveTypes.push(formattedValue);
    } else if (filter.col === "types" && filter.op === "not_contains") {
      summary.negativeTypes.push(formattedValue);
    } else if (filter.col === "moves" && filter.op === "contains") {
      summary.positiveMoves.push(formattedValue);
    } else if (filter.col === "moves" && filter.op === "not_contains") {
      summary.negativeMoves.push(formattedValue);
    } else if (filter.col === "abilities" && filter.op === "contains") {
      summary.positiveAbilities.push(formattedValue);
    } else if (filter.col === "abilities" && filter.op === "not_contains") {
      summary.negativeAbilities.push(formattedValue);
    }
  }

  return summary;
}

function buildCriteriaClause(filters: QueryFilter[], singular: boolean): string {
  const {
    positiveTypes,
    negativeTypes,
    positiveMoves,
    negativeMoves,
    positiveAbilities,
    negativeAbilities,
  } = summarizeFilters(filters);

  const clauses: string[] = [];

  if (positiveTypes.length > 0) {
    clauses.push(`${joinWithAnd(positiveTypes)} Pokemon`);
  } else {
    clauses.push("Pokemon");
  }

  if (negativeTypes.length > 0) {
    clauses.push(`that ${singular ? "is" : "are"} not ${joinWithAnd(negativeTypes)}-type`);
  }

  if (positiveMoves.length > 0) {
    clauses.push(`that ${singular ? "knows" : "know"} ${joinWithAnd(positiveMoves)}`);
  }

  if (negativeMoves.length > 0) {
    clauses.push(`that ${singular ? "does" : "do"} not know ${joinWithAnd(negativeMoves)}`);
  }

  if (positiveAbilities.length > 0) {
    clauses.push(`that ${singular ? "has" : "have"} ${joinWithAnd(positiveAbilities)}`);
  }

  if (negativeAbilities.length > 0) {
    clauses.push(`that ${singular ? "does" : "do"} not have ${joinWithAnd(negativeAbilities)}`);
  }

  return clauses.join(" ");
}

function normalizeAnswerSpacing(value: string): string {
  return value.replaceAll(SPACE_NORMALIZATION_PATTERN, " ");
}

export async function answerInEnglish(plan: QueryPlan, results: string[]): Promise<string> {
  const normalizedResults = dedupePokemonResults(results);
  if (normalizedResults.length === 0) {
    const criteria = buildCriteriaClause(plan.filters ?? [], false);
    return `No ${criteria.toLowerCase()} were found.`;
  }

  const singular = normalizedResults.length === 1;
  const criteria = buildCriteriaClause(plan.filters ?? [], singular);
  const verb = singular ? "is" : "are";
  const names = joinWithAnd(normalizedResults);

  return normalizeAnswerSpacing(`The ${criteria} ${verb} ${names}.`);
}
