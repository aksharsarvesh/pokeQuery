"use client";

import type { FormEvent } from "react";
import { useState } from "react";

type SearchState = {
  error: string;
  response: string;
};

async function submitPokemonQuery(query: string): Promise<string> {
  const response = await fetch("/api/search_from_text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const payload = (await response.json().catch(() => null)) as
    | string
    | { detail?: unknown }
    | null;

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && typeof payload.detail === "string"
        ? payload.detail
        : "Failed to fetch results";
    throw new Error(detail);
  }

  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchState, setSearchState] = useState<SearchState>({
    error: "",
    response: "",
  });

  const trimmedQuery = query.trim();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedQuery) {
      setSearchState({
        error: "Enter a Pokemon query before submitting.",
        response: "",
      });
      return;
    }

    try {
      setIsSubmitting(true);
      setHasSearched(true);
      setSearchState({ error: "", response: "" });

      const response = await submitPokemonQuery(trimmedQuery);
      setSearchState({ error: "", response });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setSearchState({ error: message, response: "" });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-background px-6 py-16 text-foreground sm:px-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
        <header className="space-y-3">
          <p className="text-sm uppercase tracking-[0.3em] text-foreground/60">
            PokéQuery
          </p>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Search Pokémon for VGC
          </h1>
        </header>

        <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.03] p-6 shadow-sm sm:p-8">
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <input
              id="query"
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Example: Non-fire types that can learn flare blitz but not flame thrower"
              className="w-full rounded-2xl border border-foreground/15 bg-background px-4 py-3 outline-none transition focus:border-foreground/35"
            />
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={isSubmitting || !trimmedQuery}
                className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? "Searching..." : "Search"}
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-3xl border border-foreground/10 bg-background p-6 sm:p-8">
          <h2 className="text-sm font-medium uppercase tracking-[0.25em] text-foreground/50">
            Result
          </h2>
          {searchState.error ? (
            <p className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-700">
              {searchState.error}
            </p>
          ) : searchState.response ? (
            <p className="mt-4 text-lg leading-8 text-foreground/85">
              {searchState.response}
            </p>
          ) : isSubmitting ? (
            <p className="mt-4 text-sm leading-7 text-foreground/55">
              Thinking...
            </p>
          ) : hasSearched ? (
            <p className="mt-4 text-sm leading-7 text-foreground/55">
              No result yet.
            </p>
          ) : (
            <p className="mt-4 text-sm leading-7 text-foreground/55">
              Describe the Pokemon you want to find.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
