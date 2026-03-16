import { NextResponse } from "next/server";

type ErrorBody = {
  detail: string;
};

export async function readJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

export function badRequest(error: unknown) {
  const detail = error instanceof Error ? error.message : "Unknown error";
  return NextResponse.json<ErrorBody>({ detail }, { status: 400 });
}
