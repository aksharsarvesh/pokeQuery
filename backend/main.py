import json
import os
from dataclasses import dataclass
from typing import Any, Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel
from supabase import create_client

app = FastAPI()

# Allow local dev plus any configured production frontend origin.
frontend_origin = os.getenv("FRONTEND_ORIGIN")
allowed_origins = ["http://localhost:3000"]
if frontend_origin:
    allowed_origins.append(frontend_origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


load_dotenv()
supabase_url = require_env("SUPABASE_URL")
supabase_key = require_env("SUPABASE_KEY")
db = create_client(supabase_url, supabase_key)
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
cerebras_api_key = os.getenv("CEREBRAS_API_KEY")
cerebras_model = os.getenv("CEREBRAS_MODEL", "gpt-oss-120b")
cerebras_client = (
    OpenAI(base_url="https://api.cerebras.ai/v1", api_key=cerebras_api_key)
    if cerebras_api_key
    else None
)

AllowedOp = Literal[
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "like",
    "ilike",
    "in",
    "contains",
    "not_contains",
]

ALLOWED_TABLES = {"pokemon_data"}
ALLOWED_COLUMNS = {
    "pokemon_data": {"name", "types", "moves", "abilities"},
}
MAX_LIMIT = 2000
MAX_TYPES = 2
MAX_MOVES = 4
MAX_ABILITIES = 1


@dataclass
class Filter:
    col: str
    op: AllowedOp
    val: Any


def _apply_filter(q, table: str, f: dict) -> Any:
    col = f["col"]
    op: AllowedOp = f["op"]
    val = f["val"]

    if col not in ALLOWED_COLUMNS.get(table, set()):
        raise ValueError(f"Disallowed column: {table}.{col}")

    if op == "eq":
        return q.eq(col, val)
    if op == "neq":
        return q.neq(col, val)
    if op == "gt":
        return q.gt(col, val)
    if op == "gte":
        return q.gte(col, val)
    if op == "lt":
        return q.lt(col, val)
    if op == "lte":
        return q.lte(col, val)
    if op == "like":
        return q.like(col, val)
    if op == "ilike":
        return q.ilike(col, val)
    if op == "in":
        if not isinstance(val, list):
            raise ValueError("in operator requires a list")
        return q.in_(col, val)
    if op == "contains":
        if not isinstance(val, list):
            raise ValueError("contains operator requires a list")
        return q.contains(col, val)
    if op == "not_contains":
        if not isinstance(val, list):
            raise ValueError("not_contains operator requires a list")
        return q.not_.contains(col, val)

    raise ValueError(f"Unsupported op: {op}")


def execute_supabase_plan(supabase, plan: dict) -> list[dict]:
    table = plan["table"]
    if table not in ALLOWED_TABLES:
        raise ValueError(f"Disallowed table: {table}")

    select = plan.get("select", "*")
    limit = int(plan.get("limit", 100))
    limit = min(max(limit, 1), MAX_LIMIT)

    q = supabase.from_(table).select(select)

    for f in plan.get("filters", []):
        q = _apply_filter(q, table, f)
        
    for o in plan.get("order", []):
        col = o["col"]
        asc = bool(o.get("ascending", True))
        if col not in ALLOWED_COLUMNS.get(table, set()):
            raise ValueError(f"Disallowed order column: {table}.{col}")
        q = q.order(col, desc=not asc)

    q = q.limit(limit)

    resp = q.execute()
    data = getattr(resp, "data", None)
    err = getattr(resp, "error", None)

    if err:
        raise RuntimeError(err)

    return data or []


def _normalize_list(value: Any, max_items: int) -> list[str]:
    if not isinstance(value, list):
        return []
    seen = set()
    out: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        cleaned = item.strip().lower()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
        if len(out) >= max_items:
            break
    return out


def extract_criteria_from_text(query: str) -> dict:
    if not openai_client.api_key:
        raise ValueError("Missing OPENAI_API_KEY")

    system = (
        "You extract search criteria for Pokemon and return only JSON. "
        "Return only JSON with keys "
        '"types", "moves", "abilities", "exclude_types", "exclude_moves", '
        '"exclude_abilities", "notes". Values must be arrays of lowercase strings. '
        "Do not add any keys outside that schema. "
        "Only include items explicitly requested by the user. "
        "Correct spelling and spacing to canonical move/ability/type names. "
        "Do not copy the terms directly. Confirm each is a real type/move/ability and is spelled and spaced correctly. "
        "If a user token appears to be concatenated, split it into the intended multi-word term. "
        "If truly ambiguous, or if they are requesting unknown criteria, it may not be in your training data; Use your best judgement for what the user meant. "
        "Also in the notes attribute write down any editing you had to make to the query, how and why."
    )
    user = f"Query: {query}"

    resp = cerebras_client.chat.completions.create(
        model=cerebras_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
    )
    content = resp.choices[0].message.content or "{}"
    data = json.loads(content)
    print(data)
    types = _normalize_list(data.get("types", []), MAX_TYPES)
    moves = _normalize_list(data.get("moves", []), MAX_MOVES)
    abilities = _normalize_list(data.get("abilities", []), MAX_ABILITIES)
    exclude_types = _normalize_list(data.get("exclude_types", []), MAX_TYPES)
    exclude_moves = _normalize_list(data.get("exclude_moves", []), MAX_MOVES)
    exclude_abilities = _normalize_list(data.get("exclude_abilities", []), MAX_ABILITIES)
    return {
        "types": types,
        "moves": moves,
        "abilities": abilities,
        "exclude_types": exclude_types,
        "exclude_moves": exclude_moves,
        "exclude_abilities": exclude_abilities,
    }


def build_plan_from_criteria(criteria: dict) -> dict:
    filters = []
    if criteria.get("types"):
        filters.append({"col": "types", "op": "contains", "val": criteria["types"]})
    if criteria.get("moves"):
        filters.append({"col": "moves", "op": "contains", "val": criteria["moves"]})
    if criteria.get("abilities"):
        filters.append(
            {"col": "abilities", "op": "contains", "val": criteria["abilities"]}
        )
    if criteria.get("exclude_types"):
        filters.append(
            {"col": "types", "op": "not_contains", "val": criteria["exclude_types"]}
        )
    if criteria.get("exclude_moves"):
        filters.append(
            {"col": "moves", "op": "not_contains", "val": criteria["exclude_moves"]}
        )
    if criteria.get("exclude_abilities"):
        filters.append(
            {
                "col": "abilities",
                "op": "not_contains",
                "val": criteria["exclude_abilities"],
            }
        )
    return {
        "table": "pokemon_data",
        "select": "name",
        "filters": filters,
        "limit": 200,
    }


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/search")
def search(plan: dict):
    try:
        rows = execute_supabase_plan(db, plan)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"results": [row.get("name") for row in rows]}

def answer_in_english(criteria, results):
    if not cerebras_client:
        raise ValueError("Missing CEREBRAS_API_KEY")

    system = (
        "You are given a list of pokemon names along with criteria that they all fulfill "
        "Criteria will include 6 lists of types, moves, abilities, as well as exclusions of those "
        "For each of these lists that aren't empty, please declare in plain English that the pokemon (capitalized names) that meet these criteria are the list "
        "For example, '<type> pokemon that know <move_1> and <move_2> and have <ability> are <pokemon_1>, <pokemon_2>, and <pokemon_3>"
        "Capitalize the criteria. "
        "Finally, some pokemon have special names with hyphens. The following are rules to handle these "
        "If the pokemon is a mega pokemon, call it 'mega <pokemon_name>' i.e. "
        "<pokemon_name>-'mega' -> Mega <pokemon_name> "
        "<pokemon_name>-'mega-x' -> Mega <pokemon_name> X"
        "<pokemon_name>-'mega-y' -> Mega <pokemon_name> Y"
        "If the pokemon is a regional form, please state the region first as an adjective as in the following. Please follow this mapping exactly, as these are the only possible regional forms"
        "<pokemon_name>-'alola' -> Alolan <pokemon_name> "
        "<pokemon_name>-'galar' -> Galarian <pokemon_name> "
        "<pokemon_name>-'paldea' -> Paldean <pokemon_name> "
        "<pokemon_name>-'hisui' -> Hisuian <pokemon_name> "
        "If there are duplicates that are not regional or mega form differences, then include one copy of the species name (shared prefix). Do not include the other form data. If there are multiple pokemon with very similar names, this is an indication that they should be grouped. "
        "It's very important that you format the names in that way. Double check there are no hyphens and regions come before species name, but do not add regional/mega information that wasn't in the name of the pokemon already "
        "Return one sentence only"
    )
    user = f"Criteria: {criteria}, Results: {results}"
    
    resp = cerebras_client.chat.completions.create(
        model=cerebras_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    text = resp.choices[0].message.content or ""
    # Normalize non-standard spaces to plain spaces for consistent rendering.
    return text.replace("\u202F", " ").replace("\u00A0", " ").replace("\u2009", " ")
class TextQueryRequest(BaseModel):
    query: str

@app.post("/api/search_from_text")
def search_from_text(payload: TextQueryRequest):
    query = payload.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Missing query")

    try:
        criteria = extract_criteria_from_text(query)
        print(criteria)
        plan = build_plan_from_criteria(criteria)
        print(plan)
        rows = execute_supabase_plan(db, plan)
    except (ValueError, RuntimeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    results = [row.get("name") for row in rows]
    print(results)
    answer = answer_in_english(criteria, results)
    return answer
