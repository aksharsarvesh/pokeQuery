import { NextResponse } from "next/server";
import { inspect } from "node:util";

import { badRequest, readJsonBody } from "@/lib/server/api-errors";
import { searchPokemon, type QueryPlan } from "@/lib/server/pokemon-search";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const plan = await readJsonBody<QueryPlan>(request);
    console.log("[api/search] plan", inspect(plan, { depth: null, colors: false }));
    const results = await searchPokemon(plan);
    console.log("[api/search] rows", inspect(results, { depth: null, colors: false }));

    return NextResponse.json({
      results,
    });
  } catch (error) {
    return badRequest(error);
  }
}
