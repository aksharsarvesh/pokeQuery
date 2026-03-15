"use client";

import { useState } from "react";

export default function Home() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState("");

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };
  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      setLoading(true);
      const res = await fetch("/api/search_from_text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      if (!res.ok) throw new Error("Failed to fetch results");
      const data = await res.json();
      setResponse(typeof data === "string" ? data : JSON.stringify(data, null, 2));
      
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Error fetching results:", message);
      alert("Failed to retrieve pokemon: " + message);
    } finally {
      setLoading(false);
    }
    
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-background font-sans">
      <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-between bg-background py-32 px-16 sm:items-start">

        <div className="flex flex-col items-center gap-6 text-center sm:items-start sm:text-left">
          <h1 className="max-w-xs text-3xl font-semibold leading-10 tracking-tight text-foreground">
            PokéQuery
          </h1>
          <form onSubmit={handleSubmit} className="flex w-full max-w-md flex-col gap-3">
            <input
              type="text"
              id="name-input"
              value={query}
              onChange={handleChange}
              placeholder="Type something..."
              className="w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-foreground"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-fit rounded-md border border-foreground/20 bg-background px-4 py-2 text-foreground"
            >
              {loading ? "Searching..." : "Submit"}
            </button>
          </form>
          <p className="max-w-md text-pretty text-foreground/80">{response}</p>
        </div>

      </main>
    </div>
  );
}
