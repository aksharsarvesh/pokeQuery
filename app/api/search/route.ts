import { NextResponse } from "next/server";
import { inspect } from "node:util";

import { executeSupabasePlan, type QueryPlan } from "@/lib/server/pokemon-search";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const plan = (await request.json()) as QueryPlan;
    console.log("[api/search] plan", inspect(plan, { depth: null, colors: false }));
    const rows = await executeSupabasePlan(plan);
    console.log("[api/search] rows", inspect(rows, { depth: null, colors: false }));
    return NextResponse.json({
      results: rows.map((row) => row.name).filter((name): name is string => typeof name === "string"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[api/search] error", message, error);
    return NextResponse.json({ detail: message }, { status: 400 });
  }
}
