import os
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()
gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
# Debug: Print available models
if __name__ == "__main__":
    for model in gemini_client.models.list():
        print(model.name)