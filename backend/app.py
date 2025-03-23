from flask import Flask, request, jsonify
from flask_cors import CORS, cross_origin
import os
import boto3
import json
from dotenv import load_dotenv
import subprocess
load_dotenv()

# For SBERT embeddings and cosine similarity computation.
from sentence_transformers import SentenceTransformer
import numpy as np
from numpy.linalg import norm

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# First endpoint: convert high-level to low-level
@app.route('/convert_high_to_low', methods=['POST'])
def convert_high_to_low():
    data = request.json
    feature_description = data.get('feature_description', '')
    
    if not feature_description:
        return jsonify({'error': 'No feature description provided'}), 400

    prompt = create_llm_prompt(feature_description)
    
    print("prompt: ", prompt)
    
    analysis_result = call_aws_bedrock(prompt)
    
    print("high level to low level plan: ", analysis_result)
    
    return jsonify({'analysis': analysis_result})

# # Second endpoint: save top-R docstrings whose corresponding files best suit the low-level plan
# @app.route('/api/saveTopR', methods=['POST'])
# def save_top_r():
#     """
#     Endpoint to save the top-R subset of docstrings computed on the frontend
#     into a local JSON file (or any other storage).
#     """
#     top_r = request.get_json()  # Expecting a JSON body with the top-R docstrings
#     # Define the output directory (you can adjust the location as needed)
#     output_dir = os.path.join(os.path.dirname(__file__), '..', 'data')
#     os.makedirs(output_dir, exist_ok=True)
#     top_r_path = os.path.join(output_dir, 'TopR_docstrings.json')

#     # Write the top-R docstrings to file in JSON format
#     with open(top_r_path, 'w', encoding='utf-8') as f:
#         json.dump(top_r, f, indent=2, ensure_ascii=False)

#     return jsonify({'status': 'success', 'message': 'Top-R docstrings saved successfully.'}), 200


# Second endpoint: save top-R docstrings whose corresponding files best suit the low-level plan
@app.route('/api/saveTopR', methods=['POST'])
def save_top_r():
    """
    Endpoint to compute the top-R subset of docstrings based on cosine similarity
    between the low-level plan and each docstring. Expects a JSON payload with:
      - "low_level_plan": a string
      - "docstring_results": a dictionary mapping file paths to their docstrings.
    The endpoint computes SBERT embeddings for the low-level plan and each docstring,
    selects the top 2 files with highest similarity, saves the resulting smaller hashmap to a JSON file,
    and returns it.
    """
    data = request.get_json()
    low_level_plan = data.get("low_level_plan")
    docstring_results = data.get("docstring_results")
    
    if not low_level_plan or not docstring_results:
        return jsonify({"error": "Missing low_level_plan or docstring_results"}), 400

    # Initialize SBERT model.
    model = SentenceTransformer("all-mpnet-base-v2")
    
    # Compute the embedding for the low-level plan.
    plan_embedding = model.encode([low_level_plan])[0]
    
    # Helper: compute cosine similarity between two vectors.
    def cosine_similarity(vecA, vecB):
        return np.dot(vecA, vecB) / (norm(vecA) * norm(vecB))
    
    similarities = {}
    for file, doc in docstring_results.items():
        doc_embedding = model.encode([doc])[0]
        sim = cosine_similarity(plan_embedding, doc_embedding)
        similarities[file] = sim

    # Sort files by similarity in descending order and select top 2.
    top_files = sorted(similarities, key=lambda f: similarities[f], reverse=True)[:2]
    top_r_docstrings = {file: docstring_results[file] for file in top_files}
    
    # Define output directory and save the top-R subset to a JSON file.
    output_dir = os.path.join(os.path.dirname(__file__), '..', 'data')
    os.makedirs(output_dir, exist_ok=True)
    top_r_path = os.path.join(output_dir, 'TopR_docstrings.json')
    with open(top_r_path, 'w', encoding='utf-8') as f:
        json.dump(top_r_docstrings, f, indent=2, ensure_ascii=False)

    return jsonify({'status': 'success', 'top_r_docstrings': top_r_docstrings}), 200


def create_llm_prompt(feature_description):
    """
    Create a refined intelligent specification from the given customer description
    """
    prompt = f"""
    Analyze the following high level feature description for a software feature requested by a customer and 
    please convert it into a refined low level feature description.\n\nFeature Description:\n
    {feature_description}\n\n
    Write a concise low level description.
    """
    
    '''
    Please provide:
    1. A summary of the key requirements
    2. Potential technical implementation steps
    3. Possible challenges or considerations
    4. Any suggested improvements or alternatives
    '''
    
    return prompt

def call_aws_bedrock(prompt):
    # Set up the Bedrock client
    client = boto3.client("bedrock-runtime", region_name=os.environ.get("REACT_APP_AWS_DEFAULT_REGION", "us-west-2"),
                          aws_access_key_id=os.environ.get("REACT_APP_AWS_ACCESS_KEY_ID"),
                          aws_secret_access_key=os.environ.get("REACT_APP_AWS_SECRET_ACCESS_KEY"),
                          aws_session_token=os.environ.get("REACT_APP_AWS_SESSION_TOKEN"))
    
    # Configure the request parameters
    model_id = 'us.deepseek.r1-v1:0' #'mistral.mistral-large-2407-v1:0' #'us.deepseek.r1-v1:0'  # mistral.mistral-large-2407-v1:0
    
    # Embed the prompt in DeepSeek-R1's instruction format.
    formatted_prompt = f"""
    <｜begin▁of▁sentence｜><｜User｜>{prompt}<｜Assistant｜><think>\n
    """
    
    body = json.dumps({
        "prompt": formatted_prompt, #prompt, #formatted_prompt,
        "max_tokens": 2048,
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

def mock_llm_analysis(prompt):
    """
    Mock function that simulates an LLM response.
    In a real implementation, this would be replaced with an actual API call to AWS Bedrock.
    """
    return "PLACEHOLDER"

# New endpoint to generate changed files.
@app.route('/generate_changed_files', methods=['POST'])
def generate_changed_files():
    data = request.get_json()
    # print(files)
    # print(topR)
    files = data.get('files', {})          # e.g., { "file1.py": "original content", ... }
    topR = data.get('topR', {})            # e.g., { "file1.py": "low-level plan", ... }
    # TODO: add low level plan
    low_level_plan = data.get("low_level_plan")
    docstrings = data.get('docstrings', {})  # e.g., { "file1.py": "extracted docstring", ... }

    changed_files = {}
    for file_name, content in files.items():
        if file_name in topR:
            prompt = (
                f"Code:\n{content}\n\n"
                f"Docstring of the file:\n{docstrings[file_name]}\n\n"
                f"Low-level plan for modifications:\n{low_level_plan}\n\n"
                "Please generate the updated file content by applying the changes described in the low-level plan."
                "Return only the updated code."
            )
            print("Prompt for file change: ", prompt)
            try:
                updated_content = call_aws_bedrock(prompt)
            except Exception as e:
                updated_content = f"Error processing file: {str(e)}"
        
            print("updated content: ", updated_content)
            
            '''
            dot_index = file_name.rfind('.')
            if dot_index != -1:
                new_file_name = file_name[:dot_index] + file_name[dot_index:]
            else:
                new_file_name = file_name
            '''
            new_file_name = os.path.basename(file_name)
            changed_files[new_file_name] = updated_content
            
            # Also record the updated content in the response.
            # changed_files[file_name] = updated_content
            
            # # Save the updated file locally
            # output_dir = os.path.join(os.path.dirname(__file__), 'changed_files')
            # os.makedirs(output_dir, exist_ok=True)
            # with open(os.path.join(output_dir, new_file_name), 'w', encoding='utf-8') as f:
            #     f.write(updated_content)

    return jsonify({"changed_files": changed_files})

@app.route('/run_code', methods=['GET'])
def run_code():
    try:
        # Assume main.py is generated in the changed_files folder.
        main_py_path = os.path.join(os.path.dirname(__file__), 'changed_files', 'main.py')
        if not os.path.exists(main_py_path):
            return jsonify({"error": "main.py not found. Please generate it first."}), 400
        result = subprocess.run(
            ["python", main_py_path],
            capture_output=True,
            text=True,
            timeout=60
        )
        return jsonify({"output": result.stdout, "error": result.stderr})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# New endpoint: Generate main.py by calling coworker's main_create.py.
@app.route('/generate_main', methods=['GET'])
def generate_main():
    try:
        # Assume main_create.py is in the main_build directory relative to the backend.
        main_create_path = os.path.join(os.path.dirname(__file__), '..', 'main_build', 'main_create.py')
        # The changed_files folder is used as the source.
        changed_folder = os.path.join(os.path.dirname(__file__), 'changed_files')
        if not os.path.exists(changed_folder):
            return jsonify({'error': 'Changed files folder does not exist'}), 400

        # Call main_create.py with the changed_files folder.
        result = subprocess.run(
            ["python", main_create_path, "--folder", changed_folder],
            capture_output=True,
            text=True,
            timeout=60
        )
        if result.returncode != 0:
            return jsonify({"error": result.stderr}), 500
        return jsonify({"output": result.stdout})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/docstrings.json', methods=['GET'])
def get_docstrings():
    path = os.path.join(os.path.dirname(__file__), '..', 'data', 'docstrings.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/topR.json', methods=['GET'])
def get_topR():
    path = os.path.join(os.path.dirname(__file__), '..', 'data', 'TopR_docstrings.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/saveDocstrings', methods=['POST'])
def save_docstrings():
    """
    Endpoint to save docstrings generated on the frontend
    into a local JSON file (or any other storage).
    """
    docstrings = request.get_json()  # Expecting a JSON body
    
    # You can choose a different location or name for the file
    output_dir = os.path.join(os.path.dirname(__file__), '..', 'data')
    os.makedirs(output_dir, exist_ok=True)
    docstrings_path = os.path.join(output_dir, 'docstrings.json')

    # Write docstrings to file in JSON format
    with open(docstrings_path, 'w', encoding='utf-8') as f:
        json.dump(docstrings, f, indent=2, ensure_ascii=False)

    return jsonify({'status': 'success', 'message': 'Docstrings saved successfully.'}), 200

@app.route('/run_main', methods=['POST'])
def run_main():
    data = request.get_json()
    folder = data.get('folder')
    if not folder:
        return jsonify({"error": "Missing folder path"}), 400

    # Get the absolute folder path
    abs_folder = os.path.abspath(folder)
    print("Running main.py in folder:", abs_folder)
    
    # Build the command using conda run for the 'fast' environment.
    command = "python main.py"
    
    try:
        result = subprocess.run(
            command,
            cwd=abs_folder,
            shell=True,
            capture_output=True,
            text=True,
            timeout=60  # Adjust timeout as needed
        )
        print("Command STDOUT:", result.stdout)
        print("Command STDERR:", result.stderr)
        return jsonify({
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode
        })
    except Exception as e:
        print("Error executing command:", e)
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    app.run(debug=True, host='0.0.0.0', port=port, use_reloader=False)