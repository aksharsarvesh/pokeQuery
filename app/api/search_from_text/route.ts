import { NextResponse } from "next/server";
import { inspect } from "node:util";

import {
  answerInEnglish,
  executeSupabasePlan,
  planFromText,
} from "@/lib/server/pokemon-search";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { query?: unknown };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    console.log(
      "[api/search_from_text] raw body",
      inspect(body, { depth: null, colors: false }),
    );
    console.log("[api/search_from_text] query", query);

    if (!query) {
      return NextResponse.json({ detail: "Missing query" }, { status: 400 });
    }

    const plan = await planFromText(query);
    console.log(
      "[api/search_from_text] plan",
      inspect(plan, { depth: null, colors: false }),
    );
    const rows = await executeSupabasePlan(plan);
    console.log(
      "[api/search_from_text] rows",
      inspect(rows, { depth: null, colors: false }),
    );
    const results = rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string");
    console.log(
      "[api/search_from_text] results",
      inspect(results, { depth: null, colors: false }),
    );
    const answer = await answerInEnglish(plan, results);
    console.log("[api/search_from_text] answer", answer);

    return NextResponse.json(answer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[api/search_from_text] error", message, error);
    return NextResponse.json({ detail: message }, { status: 400 });
  }
}
