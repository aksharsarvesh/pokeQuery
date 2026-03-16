# PokeQuery

PokeQuery is a Next.js app that turns plain-English Pokemon search requests into
structured Supabase queries. The active code path lives in the App Router under
[`app/`](/Users/asarvesh/Documents/pokeQuery/app) and the shared server logic
lives in [`lib/server/`](/Users/asarvesh/Documents/pokeQuery/lib/server).

## Development

Install dependencies and start the app:

```bash
npm install
npm run dev
```

The app expects these environment variables:

- `SUPABASE_URL`
- `SUPABASE_KEY`
- `CEREBRAS_API_KEY`
- `CEREBRAS_MODEL` (optional, defaults to `gpt-oss-120b`)

## Request Flow

1. The UI in [`app/page.tsx`](/Users/asarvesh/Documents/pokeQuery/app/page.tsx)
   sends a natural-language query to
   [`app/api/search_from_text/route.ts`](/Users/asarvesh/Documents/pokeQuery/app/api/search_from_text/route.ts).
2. [`lib/server/pokemon-search.ts`](/Users/asarvesh/Documents/pokeQuery/lib/server/pokemon-search.ts)
   asks the model for a structured plan, runs the query against Supabase, then
   formats the final English answer.
3. [`app/api/search/route.ts`](/Users/asarvesh/Documents/pokeQuery/app/api/search/route.ts)
   is the lower-level endpoint for executing an already-structured query plan.

## Notes

- [`backend/main.py`](/Users/asarvesh/Documents/pokeQuery/backend/main.py) is an
  older backend kept for reference and is not the primary app path.
- Keep the LLM system prompt text unchanged unless there is an explicit reason
  to revisit product behavior.
