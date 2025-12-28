import os
import json
from urllib.request import urlopen
from urllib.error import URLError, HTTPError

from supabase import create_client
from supabase.lib.client_options import ClientOptions
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

def get_data(pokemon_number: int):
    url = f'https://pokeapi.co/api/v2/pokemon-species/{pokemon_number}'

    try:
        with urlopen(url, timeout=5) as r:
            species_data = json.load(r)
    except (HTTPError, URLError) as e:
        print("API not reachable:", e)
        return False
    out = list()
    for item in species_data['varieties']:
        try:
            with urlopen(item['pokemon']['url'], timeout=5) as r:
                data = json.load(r)
        except (HTTPError, URLError) as e:
            print("API not reachable:", e)
            return False
        if len(data['forms']) <= 0 or len(data['moves']) <= 0 or len(data['abilities']) <= 0:
            continue 
        name = data['forms'][0]['name']
        moves = [move['move']['name'].replace('-', ' ') for move in data['moves']]
        abilities = [ability['ability']['name'].replace('-', ' ') for ability in data['abilities']]  
        types = [t['type']['name'] for t in data['types']]
        out.append({"name": name, "moves": moves, "abilities": abilities, "types": types}   )
    return out
        

if __name__ == "__main__":
    
    for i in range(NUM_POKEMON):
        print(f'getting {i + 1}')
        for item in get_data(i + 1):
            pokemon_data.insert(item).execute()

        print(f'done with {i + 1}')
        
    
