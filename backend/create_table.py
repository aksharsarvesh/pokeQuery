import os
import json
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

from supabase import create_client
from dotenv import load_dotenv


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


load_dotenv()
supabase_url = require_env("SUPABASE_URL")
supabase_key = require_env("SUPABASE_KEY")
db = create_client(supabase_url, supabase_key)
pokemon_data = db.table("pokemon_data")

NUM_POKEMON = 1025
TYPE_CHART_PATH = Path(__file__).with_name("type_chart.json")


def load_type_chart(path: Path) -> dict[str, dict[str, float]]:
    with path.open() as f:
        raw_chart = json.load(f)

    chart: dict[str, dict[str, float]] = {}
    for attack_type, defenders in raw_chart.items():
        if not isinstance(attack_type, str) or not isinstance(defenders, dict):
            raise ValueError("Type chart must be a mapping of attack types to defender maps")

        cleaned_attack_type = attack_type.strip().lower()
        cleaned_defenders: dict[str, float] = {}
        for defender_type, multiplier in defenders.items():
            if not isinstance(defender_type, str):
                raise ValueError("Defender type names in the chart must be strings")
            cleaned_defenders[defender_type.strip().lower()] = float(multiplier)
        chart[cleaned_attack_type] = cleaned_defenders

    return chart


TYPE_CHART = load_type_chart(TYPE_CHART_PATH)


def compute_type_resists(
    pokemon_types: list[str], type_chart: dict[str, dict[str, float]]
) -> list[str]:
    normalized_types = [pokemon_type.strip().lower() for pokemon_type in pokemon_types]
    if not normalized_types:
        return []

    missing_defender_types = [
        pokemon_type
        for pokemon_type in normalized_types
        if not any(pokemon_type in defenders for defenders in type_chart.values())
    ]
    if missing_defender_types:
        missing = ", ".join(sorted(set(missing_defender_types)))
        raise ValueError(f"Missing type chart entries for defender types: {missing}")

    resisted_types: list[str] = []
    for attack_type, defenders in type_chart.items():
        multiplier = 1.0
        for defender_type in normalized_types:
            multiplier *= defenders.get(defender_type, 1.0)
        if multiplier < 1:
            resisted_types.append(attack_type)

    return resisted_types


def fetch_json(url: str, timeout: int = 10):
    req = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 pokeQuery/1.0",
        },
    )
    with urlopen(req, timeout=timeout) as r:
        return json.load(r)

def get_data(pokemon_number: int):
    url = f'https://pokeapi.co/api/v2/pokemon-species/{pokemon_number}'
    print(f"[pokeapi] fetching species {pokemon_number}: {url}")

    try:
        species_data = fetch_json(url, timeout=10)
    except (HTTPError, URLError) as e:
        print(f"[pokeapi] species fetch failed for {pokemon_number}: {e}")
        return []
    out = list()
    is_legendary = bool(species_data.get("is_legendary", False))
    for item in species_data['varieties']:
        variety_url = item['pokemon']['url']
        print(f"[pokeapi] fetching variety for {pokemon_number}: {variety_url}")
        try:
            data = fetch_json(item['pokemon']['url'], timeout=10)
        except (HTTPError, URLError) as e:
            print(f"[pokeapi] variety fetch failed for {pokemon_number}: {variety_url} -> {e}")
            return []
        if len(data['forms']) <= 0 or len(data['moves']) <= 0 or len(data['abilities']) <= 0:
            continue
        name = data['name']
        moves = [move['move']['name'].replace('-', ' ') for move in data['moves']]
        abilities = [ability['ability']['name'].replace('-', ' ') for ability in data['abilities']]
        types = [t['type']['name'] for t in data['types']]
        type_resists = compute_type_resists(types, TYPE_CHART)
        out.append(
            {
                "name": name,
                "is_legendary": is_legendary,
                "moves": moves,
                "abilities": abilities,
                "types": types,
                "type_resists": type_resists,
            }
        )
    return out


if __name__ == "__main__":

    for i in range(NUM_POKEMON):
        print(f'getting {i + 1}')
        items = get_data(i + 1)
        print(f"[pokeapi] built {len(items)} row(s) for species {i + 1}")
        for item in items:
            print(f"[supabase] inserting species {i + 1}: {item['name']}")
            try:
                pokemon_data.insert(item).execute()
            except Exception as e:
                print(f"[supabase] insert failed for species {i + 1}: {item['name']} -> {e}")
                raise
            print(f"[supabase] insert succeeded for species {i + 1}: {item['name']}")

        print(f'done with {i + 1}')
