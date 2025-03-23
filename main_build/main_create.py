#!/usr/bin/env python3
import argparse, re, os
from pathlib import Path
from tqdm import tqdm
from dotenv import load_dotenv
from openai import OpenAI
import boto3
import json

load_dotenv()

def gather_sources(root: Path):
    files=[]
    for f in tqdm(root.rglob("*.py"), desc="Scanning"):
        try:
            files.append((str(f.relative_to(root)), f.read_text()))
        except Exception as e:
            print(f"⚠️ Failed reading {f}: {e}")
    return files

def build_prompt(sources):
    prompt = (
        "You are given a Python project’s source files. Generate a better and complete main.py "
        "that imports each top‑level function and calls it, printing its return value.\n"
    )
    for path, src in sources:
        prompt += f"\n### File: {path}\n```python\n{src}\n```"
    return prompt

def extract_code(text):
    m = re.search(r"```(?:python)?\n(.+?)```", text, flags=re.S)
    return m.group(1).strip() if m else text.strip()

def call_aws_bedrock(prompt):
    # Set up the Bedrock client
    client = boto3.client("bedrock-runtime", region_name=os.environ.get("REACT_APP_AWS_DEFAULT_REGION", "us-west-2"),
                          aws_access_key_id=os.environ.get("REACT_APP_AWS_ACCESS_KEY_ID"),
                          aws_secret_access_key=os.environ.get("REACT_APP_AWS_SECRET_ACCESS_KEY"),
                          aws_session_token=os.environ.get("REACT_APP_AWS_SESSION_TOKEN"))
    
    # Configure the request parameters
    model_id = 'us.deepseek.r1-v1:0' #'mistral.mistral-large-2407-v1:0' #'us.deepseek.r1-v1:0'  # mistral.mistral-large-2407-v1:0
    
    # Define the system prompt
    system_prompt = (
        "Generate a valid Python main.py that imports and calls every top‑level function "
        "found in the provided source files, printing each return value. Return only Python code."
    )
    
    # Embed the system prompt and user prompt into DeepSeek-R1's instruction format.
    formatted_prompt = f"""
    <｜begin▁of▁sentence｜><｜System｜>{system_prompt}<｜User｜>{prompt}<｜Assistant｜><think>\n
    """
    
    body = json.dumps({
        "prompt": formatted_prompt, #prompt, #formatted_prompt,
        "max_tokens": 1024,
        "temperature": 0.5,
        "top_p": 0.9,
    })
    
    # Call the model
    response = client.invoke_model(
        modelId=model_id,
        body=body
    )
    
    # Process and return the response
    model_response = json.loads(response["body"].read())    
    return model_response["choices"][0]["text"]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path, help="Project root folder")
    
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="us.deepseek.r1-v1:0")
    parser.add_argument("--folder", required=True, help="Folder containing source files")
    args = parser.parse_args()

    # Resolve target folder.
    root = Path(os.path.abspath(args.folder))
    print(f"📂 Target folder → {root}")

    sources = gather_sources(root)
    print(f"📄 Found {len(sources)} Python files")

    prompt = build_prompt(sources)
    print(f"✉️ Sending prompt ({len(prompt):,} chars)…")
    response_text = call_aws_bedrock(prompt)
    print("Response from Bedrock:")
    print(response_text)

    code = extract_code(response_text)
    print(f"📬 Received main.py ({len(code):,} chars)")

    out = root / "main.py"
    out.write_text(code)
    print(f"✅ Wrote {out}")

if __name__ == "__main__":
    main()