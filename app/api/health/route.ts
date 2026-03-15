import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  console.log("[api/health] health check");
  return NextResponse.json({ status: "ok" });
}
