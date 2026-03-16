import { NextResponse } from "next/server";
import { inspect } from "node:util";

import { badRequest, readJsonBody } from "@/lib/server/api-errors";
import { searchPokemonFromText } from "@/lib/server/pokemon-search";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{ query?: unknown }>(request);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    console.log("[api/search_from_text] query", query);

    if (!query) {
      return NextResponse.json({ detail: "Missing query" }, { status: 400 });
    }

    const { answer, plan, results } = await searchPokemonFromText(query);
    console.log(
      "[api/search_from_text] plan",
      inspect(plan, { depth: null, colors: false }),
    );
    console.log(
      "[api/search_from_text] results",
      inspect(results, { depth: null, colors: false }),
    );
    console.log("[api/search_from_text] answer", answer);

    return NextResponse.json(answer);
  } catch (error) {
    return badRequest(error);
  }
}
