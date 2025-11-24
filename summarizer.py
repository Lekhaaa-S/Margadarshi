import os
import io
from flask import Flask, request, jsonify
from flask import send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
import requests
from PyPDF2 import PdfReader
from flask import request as flask_request

load_dotenv()

GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')
GEMINI_API_URL = os.getenv('GEMINI_API_URL')  # e.g. https://generative.googleapis.com/v1/models/text-bison-001:generateText

# Normalize GEMINI_API_KEY: strip surrounding quotes/spaces if present
if GEMINI_API_KEY:
    GEMINI_API_KEY = GEMINI_API_KEY.strip()
    if (GEMINI_API_KEY.startswith('"') and GEMINI_API_KEY.endswith('"')) or (GEMINI_API_KEY.startswith("'") and GEMINI_API_KEY.endswith("'")):
        GEMINI_API_KEY = GEMINI_API_KEY[1:-1]

app = Flask(__name__)
CORS(app)

# Debug storage for last Gemini response body (kept in-memory)
LAST_GEMINI_RESPONSE = None

print(f"GEMINI_API_KEY present: {'yes' if GEMINI_API_KEY else 'no'}")
print(f"GEMINI_API_URL: {GEMINI_API_URL or '<default>'}")

# Serve static frontend files from the project directory
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


@app.route('/', methods=['GET'])
def index():
    # Serve summarizer.html at root if it exists
    index_file = os.path.join(BASE_DIR, 'summarizer.html')
    if os.path.exists(index_file):
        return send_from_directory(BASE_DIR, 'summarizer.html')
    return jsonify({'error': 'No frontend available'}), 404
def extract_text_from_pdf(file_stream):
    try:
        reader = PdfReader(file_stream)
        text_parts = []
        for page in reader.pages:
            text = page.extract_text()
            if text:
                text_parts.append(text)
        return "\n\n".join(text_parts)
    except Exception:
        return ""


def call_gemini(prompt, max_tokens=256):
    """
    Generic caller for a Gemini-like REST endpoint. This function makes a POST to
    GEMINI_API_URL using GEMINI_API_KEY (if provided). The exact request/response
    shape may need adjustment depending on the Gemini endpoint you use.

    Assumptions:
    - If GEMINI_API_URL is set it accepts a JSON body with keys: 'prompt' and 'max_tokens'
    - Authorization via Bearer token header with GEMINI_API_KEY

    If your actual Gemini endpoint requires a different shape (for example query param ?key=...)
    update GEMINI_API_URL and headers/body accordingly.
    """
    if not GEMINI_API_URL or not GEMINI_API_KEY:
        return None, 'Gemini URL or API key not configured on server. Set GEMINI_API_URL and GEMINI_API_KEY in .env.'
    # Prefer Google-style Gemini endpoint shape (x-goog-api-key header and contents payload)
    url = GEMINI_API_URL or "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    headers = {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
    }

    payload = {
        'contents': [
            {
                'parts': [
                    {'text': prompt}
                ]
            }
        ]
    }

    max_attempts = 4
    base_backoff = 1.0
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            print(f"Calling Gemini (attempt {attempt}/{max_attempts})...")
            resp = requests.post(url, json=payload, headers=headers, timeout=90)
            resp.raise_for_status()
        except Exception as e:
            last_err = f'Error calling Gemini API (network or HTTP): {e}'
            print(last_err)
            if attempt < max_attempts:
                import time
                sleep_for = base_backoff * (2 ** (attempt - 1))
                print(f"Retrying after {sleep_for} seconds...")
                time.sleep(sleep_for)
                continue
            return None, last_err

        try:
            body_text = resp.text
        except Exception:
            body_text = ''
        # store last full body for debugging (not printed to terminal)
        global LAST_GEMINI_RESPONSE
        LAST_GEMINI_RESPONSE = body_text
        # Print only status and size to avoid dumping the response content to the terminal
        try:
            size = len(body_text)
        except Exception:
            size = 0
        print(f"Gemini response status: {resp.status_code} (body size: {size} bytes)")

        try:
            data = resp.json()
        except Exception:
            last_err = f'Unable to parse JSON response from Gemini: {body_text}'
            print(last_err)
            if attempt < max_attempts:
                import time
                sleep_for = base_backoff * (2 ** (attempt - 1))
                time.sleep(sleep_for)
                continue
            return None, last_err

        # Try to extract generator text from Google-style 'candidates' -> content -> parts -> text
        if isinstance(data, dict):
            candidates = data.get('candidates') or data.get('outputs') or []
            if isinstance(candidates, list) and candidates:
                first = candidates[0]
                content = first.get('content') if isinstance(first, dict) else None
                if content and isinstance(content, dict):
                    parts = content.get('parts') or []
                    if parts and isinstance(parts, list) and isinstance(parts[0], dict):
                        text_resp = parts[0].get('text')
                        if text_resp and isinstance(text_resp, str) and text_resp.strip():
                            return text_resp, None

        # Fall back to other shapes (OpenAI-like choices, direct fields)
        if isinstance(data, dict):
            if 'choices' in data and isinstance(data['choices'], list) and data['choices']:
                text = data['choices'][0].get('text') or data['choices'][0].get('message', {}).get('content')
                if text:
                    return text, None
            for key in ('text', 'content', 'summary'):
                if key in data and isinstance(data[key], str) and data[key].strip():
                    return data[key], None

        last_err = 'Could not extract summary from Gemini response'
        print(last_err)
        if attempt < max_attempts:
            import time
            sleep_for = base_backoff * (2 ** (attempt - 1))
            print(f"Retrying after {sleep_for} seconds...")
            time.sleep(sleep_for)
            continue
        return None, last_err


@app.route('/debug/last_gemini', methods=['GET'])
def debug_last_gemini():
    """Return the last Gemini response body captured by the server.

    For safety this endpoint only allows requests from localhost.
    """
    allowed = ('127.0.0.1', '::1')
    remote = flask_request.remote_addr
    if remote not in allowed:
        return jsonify({'error': 'forbidden'}), 403
    return jsonify({'last_gemini_response': LAST_GEMINI_RESPONSE})


# Safer static file handler: only registered after API routes so it doesn't shadow them
@app.route('/<path:filename>')
def serve_static_after(filename):
    # Allow serving of CSS, JS and other static assets from project root
    file_path = os.path.join(BASE_DIR, filename)
    if os.path.exists(file_path):
        return send_from_directory(BASE_DIR, filename)
    # If the requested file is not found, return the app shell (index) so
    # client-side navigations and service worker installation can still work.
    index_file = os.path.join(BASE_DIR, 'summarizer.html')
    if os.path.exists(index_file):
        return send_from_directory(BASE_DIR, 'summarizer.html')
    return jsonify({'error': 'Not found'}), 404


# Explicit small routes for common assets to avoid issues with some clients
@app.route('/summarizer.css')
def serve_css():
    css_path = os.path.join(BASE_DIR, 'summarizer.css')
    if os.path.exists(css_path):
        return send_from_directory(BASE_DIR, 'summarizer.css')
    return ('', 404)


@app.route('/summarizer.js')
def serve_js():
    js_path = os.path.join(BASE_DIR, 'summarizer.js')
    if os.path.exists(js_path):
        return send_from_directory(BASE_DIR, 'summarizer.js')
    return ('', 404)


@app.route('/logo.png')
def serve_logo():
    logo_path = os.path.join(BASE_DIR, 'logo.png')
    if os.path.exists(logo_path):
        return send_from_directory(BASE_DIR, 'logo.png')
    return ('', 204)


@app.route('/manifest.json')
def serve_manifest():
    manifest_path = os.path.join(BASE_DIR, 'manifest.json')
    if os.path.exists(manifest_path):
        # Use a manifest MIME type when possible
        return send_from_directory(BASE_DIR, 'manifest.json', mimetype='application/manifest+json')
    return ('', 404)


@app.route('/list-static')
def list_static():
    """Debug endpoint: list files in BASE_DIR so we can confirm static assets exist.

    This is intended for local debugging only and can be removed later.
    """
    try:
        files = sorted(os.listdir(BASE_DIR))
        return jsonify({'files': files})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/summarize', methods=['POST'])
def summarize():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400

    f = request.files['file']
    if f.filename == '':
        return jsonify({'error': 'No selected file'}), 400

    words_requested = request.form.get('words') or request.args.get('words') or request.form.get('summaryLength')
    try:
        words = int(words_requested)
    except Exception:
        words = 100

    # Extract text from pdf
    file_stream = io.BytesIO(f.read())
    text = extract_text_from_pdf(file_stream)

    if not text.strip():
        return jsonify({'error': 'Unable to extract text from PDF or PDF is empty.'}), 400

    # Build prompt
    prompt = (
        f"Summarize the following text into approximately {words} words. "
        "Keep the important points, be concise and readable. Output only the summary, no extra commentary.\n\n"
        f"{text[:30000]}"
    )

    # Rough token estimate: 1 token ~ 0.75 words; pick a safe max tokens value
    max_tokens = max(128, int(words * 1.8))

    summary_text, err = call_gemini(prompt, max_tokens=max_tokens)
    if err:
        return jsonify({'error': err}), 500

    return jsonify({'summary': summary_text})


@app.route('/debug/summarize_text', methods=['POST'])
def debug_summarize_text():
    """Quick test endpoint: send JSON { text: '...', words: 100 } and get a summary.
    This bypasses PDF upload so you can validate the Gemini call and parsing.
    Restricted to localhost for safety (but not enforced strictly here).
    """
    try:
        data = request.get_json(force=True)
    except Exception as e:
        return jsonify({'error': 'Invalid JSON', 'details': str(e)}), 400
    text = (data.get('text') or '').strip()
    if not text:
        return jsonify({'error': 'text is required'}), 400
    try:
        words = int(data.get('words', 100))
    except Exception:
        words = 100

    prompt = (
        f"Summarize the following text into approximately {words} words. "
        "Keep the important points, be concise and readable. Output only the summary, no extra commentary.\n\n"
        f"{text[:30000]}"
    )
    max_tokens = max(128, int(words * 1.8))
    summary_text, err = call_gemini(prompt, max_tokens=max_tokens)
    if err:
        return jsonify({'error': err}), 500
    return jsonify({'summary': summary_text})


if __name__ == '__main__':
    # Run without the auto-reloader to keep a single process listening on the port.
    # This makes it easier to debug network/connectivity issues during development.
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False, threaded=True)
