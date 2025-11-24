from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os
from pathlib import Path

# If you create a `.env` file in the project root, load it here so GEMINI_API_KEY
# can be read from it automatically during development.
try:
    from dotenv import load_dotenv
    # load .env from repo root if present
    env_path = Path(__file__).resolve().parent / '.env'
    if env_path.exists():
        load_dotenv(dotenv_path=env_path)
except Exception:
    # python-dotenv not installed; continue — env vars may still be set in the environment
    pass
import base64
import io
import json
import random
import re
import time
try:
    import PyPDF2
except Exception:
    PyPDF2 = None
try:
    import requests
except Exception:
    requests = None

# --- Try to import the Google Generative AI SDK ---
# FIX: Using the correct, modern import for the 'google-genai' package.
try:
    from google import genai
except Exception:
    genai = None
    print("Google GenAI SDK not available. Install with: pip install google-genai")

# --- Configuration ---
# Prefer an environment variable for the Gemini API key. You can still paste
# a key below for quick local testing, but environment variables are safer.
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY') or None
GEMINI_REST_URL = os.environ.get('GEMINI_REST_URL') or None
# Optional: model name to use when constructing a default Google GenerativeLanguage REST URL
GEMINI_REST_MODEL = os.environ.get('GEMINI_REST_MODEL') or 'gemini-2.5-flash'
# If set to '1' or 'true' (case-insensitive), the proxy will pass the key as ?key= instead of Authorization header
GEMINI_USE_APIKEY_IN_QUERY = str(os.environ.get('GEMINI_USE_APIKEY_IN_QUERY') or '').lower() in ('1', 'true', 'yes')

client = None

# Create Flask app and enable CORS for the frontend
app = Flask(__name__)
CORS(app)

if genai:
    if GEMINI_API_KEY and not GEMINI_API_KEY.startswith('<'):
        # Try multiple initialization patterns to support different versions of the
        # `google.generativeai` package. Some distributions expose `Client`, others
        # require calling `genai.configure(...)` and then use module-level APIs.
        initialized = False

        # Preferred: genai.Client(api_key=...)
        try:
            if hasattr(genai, 'Client'):
                try:
                    client = genai.Client(api_key=GEMINI_API_KEY)
                    print("Gemini client initialized using genai.Client().")
                    initialized = True
                except Exception as e:
                    print(f"genai.Client() constructor raised: {e}")
        except Exception:
            # defensive: continue to other strategies
            pass

        # Fallback: genai.configure(api_key=...) and use module-level API
        if not initialized:
            try:
                if hasattr(genai, 'configure'):
                    try:
                        genai.configure(api_key=GEMINI_API_KEY)
                    except TypeError:
                        # Some older/newer builds use a different signature
                        genai.configure(GEMINI_API_KEY)
                    client = genai
                    initialized = True
                    print("Gemini client initialized using genai.configure(...). Using module-level API.")
            except Exception as e:
                print(f"genai.configure() attempt failed: {e}")

        # Final fallback: genai.init(...)
        if not initialized:
            try:
                if hasattr(genai, 'init'):
                    try:
                        genai.init(api_key=GEMINI_API_KEY)
                        client = genai
                        initialized = True
                        print("Gemini client initialized using genai.init(...).")
                    except Exception as e:
                        print(f"genai.init() call raised: {e}")
            except Exception as e:
                print(f"genai.init() attempt failed: {e}")

        if not initialized:
            client = None
            print("Failed to initialize Gemini client: no compatible initializer found or initialization failed.")
    else:
        print("GEMINI_API_KEY not set or looks like a placeholder. Set the GEMINI_API_KEY environment variable before starting the server.")
else:
    print("Generative AI SDK not imported; AI features will be unavailable until the package is installed.")

# --- In-memory storage for chat sessions ---
room_sessions = {}

# Function to get or create a chat session for a room
def get_chat_session(room_id):
    if room_id not in room_sessions:
        print(f"Creating new chat session for Room ID: {room_id}")
        # Create chat session only if the installed SDK exposes the expected types and chat API.
        try:
            if genai and client and hasattr(genai, 'types') and hasattr(genai.types, 'GenerateContentConfig') and hasattr(client, 'chats'):
                # System instruction is crucial for setting the AI's role and tone
                try:
                    config = genai.types.GenerateContentConfig(
                        system_instruction=(
                            "You are an encouraging and helpful AI Study Partner for a collaborative room. "
                            "Your goal is to answer questions, explain concepts, and guide group discussions concisely. "
                            "When generating quizzes, use a clear bulleted or numbered list format for the questions and answers. "
                            "Respond in plain text, avoid markdown for clarity in the chat box."
                        )
                    )
                    room_sessions[room_id] = client.chats.create(model='gemini-2.5-flash', config=config)
                except Exception as e:
                    print(f"Failed to create chat session via SDK: {e}")
                    room_sessions[room_id] = None
            else:
                print("Generative SDK chat API not available; chat session will be unavailable for this room.")
                room_sessions[room_id] = None
        except Exception as e:
            print(f"Unexpected error while creating chat session: {e}")
            room_sessions[room_id] = None
    return room_sessions.get(room_id)

# Utility to create a file Part from Base64
def create_file_part(base64_data, mime_type):
    """Decodes base64 string to bytes and creates a Part for the Gemini API."""
    try:
        file_bytes = base64.b64decode(base64_data)
        if genai and hasattr(genai, 'types') and hasattr(genai.types, 'Part'):
            return genai.types.Part.from_bytes(data=file_bytes, mime_type=mime_type)
        else:
            print("genai.types.Part not available; cannot create file Part for SDK. Skipping file part.")
            return None
    except Exception as e:
        print(f"Error creating file part: {e}")
        return None


def extract_text_from_pdf_base64(base64_data, max_chars=20000):
    """Decode base64 PDF bytes and extract text using PyPDF2. Returns a truncated string."""
    if not PyPDF2:
        print("PyPDF2 not available; cannot extract PDF text.")
        return None
    try:
        file_bytes = base64.b64decode(base64_data)
        reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
        texts = []
        for page in reader.pages:
            try:
                texts.append(page.extract_text() or "")
            except Exception:
                continue
        combined = "\n\n".join(texts)
        if len(combined) > max_chars:
            combined = combined[:max_chars]
        return combined
    except Exception as e:
        print(f"Error extracting text from PDF: {e}")
        return None


def generate_quiz_from_text(text, num_questions=3, quiz_name='Quiz'):
    """Create simple multiple-choice questions from extracted text as a fallback when AI is unavailable.
    This is a lightweight heuristic generator: it selects candidate sentences, picks a keyword from each,
    then builds 3 distractors from other words in the document. Returns the expected quiz JSON schema.
    """
    if not text or not text.strip():
        return None

    # Normalize whitespace and split into sentences
    text = re.sub(r"\s+", " ", text.strip())
    # A simple sentence splitter (not perfect but good enough for short docs)
    sentences = re.split(r'(?<=[\.\?!])\s+', text)

    # Build a pool of candidate words for distractors (words of length >=3, de-duplicated)
    pool = re.findall(r"\b[A-Za-z0-9]{3,}\b", text)
    pool = [w for w in pool if not w.isdigit()]
    # lower-case pool for diversity, but keep originals for display
    seen = set()
    pool_unique = []
    for w in pool:
        lw = w.strip()
        if not lw:
            continue
        key = lw.lower()
        if key in seen:
            continue
        seen.add(key)
        pool_unique.append(lw)

    if not pool_unique:
        return None

    # Select candidate sentences that are likely to contain factual items
    candidates = []
    for s in sentences:
        # Require sentence length and presence of at least one candidate word
        words = re.findall(r"\b[A-Za-z0-9]{3,}\b", s)
        if len(s) > 20 and len(words) >= 3:
            candidates.append((s, words))

    if not candidates:
        # Fallback: use the whole text as one candidate
        candidates = [(text[:min(len(text), 200)], re.findall(r"\b[A-Za-z0-9]{3,}\b", text))]

    # Choose up to num_questions candidates (prefer varied distribution)
    random.shuffle(candidates)
    chosen = candidates[:max(1, min(len(candidates), num_questions))]

    questions = []
    for s, words in chosen:
        # Heuristic: pick a keyword — prefer a capitalized word or the longest word
        keyword = None
        cap_words = [w for w in words if w[0].isupper() and len(w) > 3]
        if cap_words:
            keyword = cap_words[0]
        else:
            keyword = sorted(words, key=lambda x: -len(x))[0]

        # Build distractors from pool_unique, avoiding the keyword
        distractors = [w for w in pool_unique if w.lower() != keyword.lower()]
        random.shuffle(distractors)
        opts = [keyword]
        for d in distractors[:3]:
            opts.append(d)

        # If not enough distractors, fill with generic placeholders
        while len(opts) < 4:
            opts.append(f"Option {chr(65 + len(opts))}")

        # Shuffle options but remember the index of the correct answer
        random.shuffle(opts)
        answer_letter = 'A'
        try:
            idx = opts.index(keyword)
            answer_letter = ['A', 'B', 'C', 'D'][idx]
        except Exception:
            # If for some reason the keyword isn't present, mark A
            answer_letter = 'A'

        # Create a shorter question by masking the keyword in the sentence if present
        qtext = s.strip()
        # Replace the first occurrence of the keyword with '_____'
        try:
            pattern = re.compile(re.escape(keyword), flags=re.IGNORECASE)
            qmasked = pattern.sub('_____', qtext, count=1)
            if qmasked == qtext:
                # If replacement didn't change, prepend a simple question
                qmasked = f"According to the document, which of the following relates to: {keyword}?"
        except Exception:
            qmasked = f"According to the document, which of the following relates to: {keyword}?"

        questions.append({
            "question": qmasked,
            "options": opts,
            "answer": answer_letter
        })

    quiz = {"quizName": quiz_name, "questions": questions}
    return quiz


def forward_to_gemini_rest(prompt_text, model=None, timeout=60, max_retries=3):
    """Forward a text prompt to the configured Gemini REST endpoint.
    This is intentionally generic: if `GEMINI_REST_URL` is set it will be used directly.
    Otherwise we will build a default Google Generative Language URL using `GEMINI_REST_MODEL`.
    Returns the requests.Response object or raises an exception on repeated failure.
    """
    if requests is None:
        raise RuntimeError("requests library is not installed (pip install requests)")

    model_to_use = model or GEMINI_REST_MODEL

    # Candidate endpoints (try Google generateContent first which uses contents/parts body,
    # then fallback to generateText style endpoint).
    candidates = []
    if GEMINI_REST_URL:
        candidates.append((GEMINI_REST_URL, 'auto'))
    # prefer v1beta generateContent shape
    candidates.append((f"https://generativelanguage.googleapis.com/v1beta/models/{model_to_use}:generateContent", 'content'))
    # fallback v1beta2 generateText shape
    candidates.append((f"https://generativelanguage.googleapis.com/v1beta2/models/{model_to_use}:generateText", 'prompt'))

    last_exc = None
    # Try each candidate endpoint in order; for each do a retry loop
    for url, shape in candidates:
        headers = {"Content-Type": "application/json"}
        params = {}
        if GEMINI_USE_APIKEY_IN_QUERY and GEMINI_API_KEY:
            params['key'] = GEMINI_API_KEY
        elif GEMINI_API_KEY:
            use_x_goog = 'generativelanguage.googleapis.com' in url or GEMINI_API_KEY.startswith('AIza') or GEMINI_API_KEY.startswith('AIzaSy')
            if use_x_goog:
                headers['x-goog-api-key'] = GEMINI_API_KEY
            else:
                headers['Authorization'] = f"Bearer {GEMINI_API_KEY}"

        # Build body according to required shape
        if shape == 'content':
            body = {"contents": [{"parts": [{"text": prompt_text}]}]}
        else:
            body = {"prompt": {"text": prompt_text}, "temperature": 0.2, "maxOutputTokens": 800}

        for attempt in range(1, max_retries + 1):
            try:
                resp = requests.post(url, headers=headers, params=params, json=body, timeout=timeout)
                try:
                    resp.raise_for_status()
                    # Log which endpoint succeeded
                    print(f"forward_to_gemini_rest: succeeded using {url} (shape={shape})")
                    return resp
                except requests.HTTPError as http_err:
                    status = getattr(resp, 'status_code', None)
                    text = resp.text if hasattr(resp, 'text') else str(resp)
                    # If 404, this endpoint/model may not be available; break to try next candidate
                    if status == 404:
                        print(f"forward_to_gemini_rest attempt {attempt} to {url} failed: HTTP 404 (not found). Trying next endpoint.")
                        last_exc = RuntimeError(f"HTTP 404 from {url}: {text}")
                        break
                    if status == 401:
                        raise RuntimeError(f"401 Unauthorized from Gemini REST at {url}. Response: {text}. Hint: use x-goog-api-key or OAuth token.")
                    raise RuntimeError(f"HTTP {status} from Gemini REST at {url}: {text}") from http_err
            except Exception as e:
                last_exc = e
                backoff = 0.5 * (2 ** (attempt - 1))
                print(f"forward_to_gemini_rest attempt {attempt} to {url} failed: {e}. Backing off {backoff}s.")
                time.sleep(backoff)
        # try next candidate

    # If we exit the candidate loop, raise the last exception
    raise last_exc

@app.route('/ask-ai', methods=['POST'])
def ask_ai():
    if not client:
        return jsonify({"error": "AI client not initialized. Check API Key."}), 500

    data = request.get_json()
    prompt = data.get('prompt', '')
    room_id = data.get('roomId') 
    file_payload = data.get('file', None)

    if not room_id:
        return jsonify({"error": "Room ID is required."}), 400

    try:
        chat = get_chat_session(room_id)
        
        content_parts = []
        is_quiz_request = False

        # 1. Process File Payload (if present)
        if file_payload:
            file_part = create_file_part(file_payload['data'], file_payload['mimeType'])
            if not file_part:
                return jsonify({"error": "Failed to process file data."}), 500
            
            content_parts.append(file_part)
            
            # 2. AUTOMATIC ACTION CHECK (THE CHANGE IS HERE)
            mime_type = file_payload['mimeType']
            
            if mime_type.startswith('application/pdf') or mime_type.startswith('text/'):
                if not prompt.strip():
                    # ✅ NEW DEFAULT BEHAVIOR: Provide a summary/explanation
                    prompt = "Please read this document/file and provide a concise 3-point summary and explanation of the key content."
                
                # Check if the final prompt (either user's or default) is a quiz request
                if 'quiz' in prompt.strip().lower() or 'questions' in prompt.strip().lower():
                    # Ensure the prompt is detailed for the AI if it is a quiz request
                    if 'quiz' not in prompt.strip().lower(): 
                         prompt = f"{prompt.strip()}. Please create a short quiz with exactly 3 multiple-choice questions (A, B, C or D), followed by the correct answers at the end."

                    is_quiz_request = True
                    
        # 3. Add the User's Prompt
        if prompt:
            content_parts.append(prompt)
            
        if not content_parts:
             return jsonify({"error": "Prompt or file is required."}), 400

        # 4. Send the Request
        # If SDK chat session is not available, fall back to the REST proxy using the
        # available prompt and uploaded file text. This makes the send action work even
        # when the installed SDK doesn't expose chat APIs.
        if not chat:
            # Build a fallback prompt combining the user's prompt and any uploaded file text
            prompt_parts = []
            if prompt:
                prompt_parts.append(prompt)
            if file_payload and PyPDF2:
                try:
                    file_text = extract_text_from_pdf_base64(file_payload.get('data', '')) or ''
                    if file_text:
                        prompt_parts.append("Document excerpt:\n" + file_text[:15000])
                except Exception as e:
                    print(f"Failed to extract PDF for REST fallback: {e}")

            prompt_text = "\n\n".join([p for p in prompt_parts if p]) or prompt or ""

            if GEMINI_API_KEY and requests is not None:
                try:
                    resp = forward_to_gemini_rest(prompt_text)
                except Exception as e:
                    print(f"REST fallback failed for room {room_id}: {e}")
                    return jsonify({"error": "Failed to get response from AI (REST fallback).", "details": str(e)}), 500

                # Extract text from common response shapes
                ai_response_text = None
                try:
                    j = resp.json()
                    if isinstance(j, dict) and 'candidates' in j and isinstance(j['candidates'], list) and j['candidates']:
                        content = j['candidates'][0].get('content') or j['candidates'][0]
                        if isinstance(content, dict):
                            parts = content.get('parts') or []
                            if parts and isinstance(parts[0], dict):
                                ai_response_text = parts[0].get('text') or parts[0].get('content')
                except Exception:
                    pass

                if not ai_response_text:
                    ai_response_text = resp.text if hasattr(resp, 'text') else str(resp)

                if is_quiz_request:
                    ai_response_text = "✨ Quiz Generated! ✨\n\n" + (ai_response_text or "")
                return jsonify({"text": (ai_response_text or "").strip()})

            # No SDK chat and no REST key available
            return jsonify({"error": "AI client unavailable (no chat API and no REST key)."}), 500

        # SDK chat is available — use it
        response = chat.send_message(content_parts)

        # 5. Format the Response Text for Quiz requests
        if is_quiz_request:
            ai_response_text = "✨ Quiz Generated! ✨\n\n" + response.text
        else:
            ai_response_text = response.text

        return jsonify({"text": ai_response_text})

    except Exception as e:
        print(f"Error calling Gemini API for room {room_id}: {e}")
        return jsonify({"error": "Failed to get response from AI."}), 500




@app.route('/generate-quiz', methods=['POST'])
def generate_quiz():
    """Generate a structured quiz JSON from an uploaded file using the Gemini model.
    Expects JSON: { roomId (optional), quizName, numQuestions, file: { data: <base64 str>, mimeType } }
    Returns: { quizName: str, questions: [ { question, options: [A,B,C,D], answer } ] }
    """
    data = request.get_json() or {}
    room_id = data.get('roomId', 'global')
    quiz_name = data.get('quizName', data.get('text', 'Quiz')[:40] or 'Quiz')
    try:
        num_questions = int(data.get('numQuestions') or data.get('amount', 3))
    except Exception:
        num_questions = 3

    file_payload = data.get('file')
    # If the client provided raw text (frontend may pass extracted text), prefer that
    provided_text = data.get('text')

    # Extract text from uploaded PDF if present
    extracted = None
    if file_payload and PyPDF2:
        try:
            extracted = extract_text_from_pdf_base64(file_payload.get('data', ''))
        except Exception as e:
            print(f"Error extracting PDF text: {e}")

    # Choose source text: provided_text > extracted > None
    source_text = (provided_text or extracted or '').strip()

    # If GEMINI_API_KEY is present, prefer REST-based generation (no SDK required)
    if GEMINI_API_KEY and requests is not None:
        # Build prompt that asks for a strict JSON object with quizName and questions
        prompt = (
            f"You are an expert quiz maker. Read the following document text and generate exactly {num_questions} multiple-choice questions."
            " Output MUST be valid JSON and nothing else, with this schema: {\"quizName\": <string>, \"questions\": [{\"question\": <string>, \"options\": [<strA>,<strB>,<strC>,<strD>], \"answer\": <\"A\"|\"B\"|\"C\"|\"D\">} ...] }."
            f" Set \"quizName\" to \"{quiz_name}\"."
        )
        if source_text:
            # include excerpt (trim to reasonable length)
            excerpt = source_text[:16000]
            prompt = f"{prompt}\n\nDocument excerpt:\n{excerpt}"

        try:
            resp = forward_to_gemini_rest(prompt, model=GEMINI_REST_MODEL)
        except Exception as e:
            print(f"Error calling Gemini REST: {e}")
            # fallback to local generation if possible
            if source_text:
                local_quiz = generate_quiz_from_text(source_text, num_questions=num_questions, quiz_name=quiz_name)
                if local_quiz:
                    return jsonify(local_quiz)
            # final fallback: mock
            mock_questions = []
            for i in range(num_questions):
                mock_questions.append({
                    "question": f"Placeholder question {i+1} (AI unavailable)",
                    "options": ["Option A", "Option B", "Option C", "Option D"],
                    "answer": "A"
                })
            return jsonify({"quizName": quiz_name, "questions": mock_questions})

        # Try parsing response
        try:
            j = resp.json()
        except Exception:
            raw_text = resp.text
            # attempt to extract JSON object
            m = re.search(r"\{\s*\"quizName\"[\s\S]*\}", raw_text)
            if m:
                try:
                    parsed = json.loads(m.group(0))
                    return jsonify(parsed)
                except Exception:
                    pass
            # try to extract JSON array (older prompts may return list)
            m2 = re.search(r"(\[\s*\{[\s\S]*\}\s*\])", raw_text)
            if m2:
                try:
                    arr = json.loads(m2.group(0))
                    # convert list to object with quizName
                    return jsonify({"quizName": quiz_name, "questions": arr})
                except Exception:
                    pass
            # as last resort, return raw text
            return jsonify({"raw": raw_text}), 200

        # If provider returned a dict with quizName/questions, return it
        if isinstance(j, dict) and 'quizName' in j and 'questions' in j:
            return jsonify(j)

        # If provider returned a list, wrap it
        if isinstance(j, list):
            return jsonify({"quizName": quiz_name, "questions": j})

        # Try common nested shapes
        text_candidate = None
        try:
            if isinstance(j, dict) and 'candidates' in j and isinstance(j['candidates'], list) and j['candidates']:
                cand = j['candidates'][0]
                # try content.parts[0].text
                if isinstance(cand, dict):
                    content = cand.get('content') or cand
                    if isinstance(content, dict):
                        parts = content.get('parts') or []
                        if parts and isinstance(parts, list) and isinstance(parts[0], dict):
                            text_candidate = parts[0].get('text') or parts[0].get('content')
        except Exception:
            text_candidate = None

        if text_candidate:
            m = re.search(r"\{\s*\"quizName\"[\s\S]*\}", text_candidate)
            if m:
                try:
                    parsed = json.loads(m.group(0))
                    return jsonify(parsed)
                except Exception:
                    pass
            m2 = re.search(r"(\[\s*\{[\s\S]*\}\s*\])", text_candidate)
            if m2:
                try:
                    arr = json.loads(m2.group(0))
                    return jsonify({"quizName": quiz_name, "questions": arr})
                except Exception:
                    pass
            return jsonify({"raw": text_candidate}), 200

        # Nothing parsed: fallback to local generator if we have text
        if source_text:
            local_quiz = generate_quiz_from_text(source_text, num_questions=num_questions, quiz_name=quiz_name)
            if local_quiz:
                return jsonify(local_quiz)

        # Final fallback: return raw provider JSON
        return jsonify(j), 200

    # If no GEMINI key or requests not available, use local generation if possible
    if source_text:
        local_quiz = generate_quiz_from_text(source_text, num_questions=num_questions, quiz_name=quiz_name)
        if local_quiz:
            return jsonify(local_quiz)

    # Final fallback: mock quiz
    mock_questions = []
    for i in range(num_questions):
        mock_questions.append({
            "question": f"Placeholder question {i+1} (AI unavailable)",
            "options": ["Option A", "Option B", "Option C", "Option D"],
            "answer": "A"
        })
    return jsonify({"quizName": quiz_name, "questions": mock_questions})


@app.route('/generate-quiz-rest', methods=['POST'])
def generate_quiz_rest():
    """Generate a quiz by calling the Gemini REST API (configurable) instead of using the SDK.
    Accepts same input shape as /generate-quiz: { roomId, quizName, numQuestions, file: { data, mimeType } }
    This endpoint will:
      - extract text from an uploaded PDF (if provided)
      - build a strict JSON-output prompt and forward to the configured Gemini REST endpoint
      - try to parse the response as JSON and return it; otherwise fall back to local generator
    """
    if requests is None:
        return jsonify({"error": "Python 'requests' library is required for REST proxy. Install with: pip install requests"}), 500

    data = request.get_json() or {}
    quiz_name = data.get('quizName', 'Quiz')
    try:
        num_questions = int(data.get('numQuestions', 3))
    except Exception:
        num_questions = 3
    file_payload = data.get('file')

    # Prefer using extracted text for PDF inputs
    extracted = None
    if file_payload and PyPDF2:
        try:
            extracted = extract_text_from_pdf_base64(file_payload['data'])
        except Exception as e:
            print(f"Error extracting PDF text for REST flow: {e}")

    if not extracted and file_payload and not PyPDF2:
        print("No PyPDF2 available — cannot extract PDF text; proceeding without file content.")

    # Build a strict JSON instruction prompt for the model
    if extracted:
        prompt_text = (
            f"You are given the following extracted text from a document:\n\n{extracted}\n\n"
            f"Generate exactly {num_questions} multiple-choice questions based ONLY on that text. "
            "Output MUST be valid JSON and nothing else, with this schema: {\"quizName\": <string>, \"questions\": [{\"question\": <string>, \"options\": [<strA>,<strB>,<strC>,<strD>], \"answer\": <\"A\"|\"B\"|\"C\"|\"D\">} ...] }. "
            f"Set \"quizName\" to \"{quiz_name}\"."
        )
    else:
        # If we don't have extracted text, ask the model to operate on the uploaded file (if provider supports file parts)
        prompt_text = (
            f"Read the uploaded document and generate exactly {num_questions} multiple-choice questions based ONLY on that document. "
            "Output MUST be valid JSON and nothing else, with this schema: {\"quizName\": <string>, \"questions\": [{\"question\": <string>, \"options\": [<strA>,<strB>,<strC>,<strD>], \"answer\": <\"A\"|\"B\"|\"C\"|\"D\">} ...] }. "
            f"Set \"quizName\" to \"{quiz_name}\"."
        )

    # Call the REST proxy helper
    try:
        resp = forward_to_gemini_rest(prompt_text)
    except Exception as e:
        print(f"Error calling Gemini REST endpoint: {e}")
        # Fallback to local generator if we have extracted text
        if extracted:
            local_quiz = generate_quiz_from_text(extracted, num_questions=num_questions, quiz_name=quiz_name)
            if local_quiz:
                return jsonify(local_quiz)
        return jsonify({"error": "Failed to call Gemini REST endpoint."}), 500

    # Try to parse the response. Different providers may embed text in different fields.
    try:
        j = resp.json()
    except Exception:
        text = resp.text
        # Attempt to extract JSON substring from text
        m = re.search(r"\{\s*\"quizName\"[\s\S]*\}", text)
        if m:
            try:
                parsed = json.loads(m.group(0))
                return jsonify(parsed)
            except Exception:
                pass
        # As a last resort, return raw text
        return jsonify({"raw": text}), 200

    # If the provider returned JSON directly, try to find sensible fields
    if isinstance(j, dict) and 'quizName' in j and 'questions' in j:
        return jsonify(j)

    # Try to find textual content in common response shapes
    text_candidate = None
    try:
        if 'candidates' in j and isinstance(j['candidates'], list) and j['candidates']:
            text_candidate = j['candidates'][0].get('content') or j['candidates'][0].get('text')
        if not text_candidate and 'output' in j and isinstance(j['output'], list) and j['output']:
            for o in j['output']:
                if isinstance(o, dict):
                    text_candidate = o.get('content') or o.get('text') or text_candidate
    except Exception:
        text_candidate = None

    if text_candidate:
        m = re.search(r"\{\s*\"quizName\"[\s\S]*\}", text_candidate)
        if m:
            try:
                parsed = json.loads(m.group(0))
                return jsonify(parsed)
            except Exception:
                pass
        return jsonify({"raw": text_candidate}), 200

    if extracted:
        local_quiz = generate_quiz_from_text(extracted, num_questions=num_questions, quiz_name=quiz_name)
        if local_quiz:
            return jsonify(local_quiz)

    return jsonify(j), 200


# --------------------
# Static file routes (serve the frontend from the shared `static/` folder)
# --------------------
STATIC_ROOT = os.path.join(os.path.abspath(os.path.dirname(__file__)), 'static')

@app.route('/', methods=['GET'])
def serve_index():
    # Serve the studyroom HTML from the repository's `static` folder so the
    # file is reachable whether the app runs standalone or is mounted under
    # a DispatcherMiddleware at /study.
    return send_from_directory(STATIC_ROOT, 'studyroom1.html')


@app.route('/<path:filename>', methods=['GET'])
def serve_file(filename):
    # Serve static assets (js, css, images) from the common `static/` folder.
    file_path = os.path.join(STATIC_ROOT, filename)
    if os.path.exists(file_path):
        return send_from_directory(STATIC_ROOT, filename)
    return jsonify({"error": "Not Found"}), 404


@app.route('/debug-ai', methods=['GET'])
def debug_ai():
    """Return simple diagnostics about AI availability for quick checks from the browser or curl."""
    sdk_available = genai is not None
    client_ready = client is not None
    key_present = bool(GEMINI_API_KEY and not GEMINI_API_KEY.startswith('<'))
    info = {
        'sdk_available': sdk_available,
        'client_ready': client_ready,
        'gemini_key_present': key_present,
        'gemini_key_preview': (GEMINI_API_KEY[:4] + '...' + GEMINI_API_KEY[-4:]) if GEMINI_API_KEY and len(GEMINI_API_KEY) > 8 else None
    }
    return jsonify(info)


@app.route('/explain-answer', methods=['POST'])
def explain_answer():
    try:
        data = request.get_json(force=True)
    except Exception as e:
        return jsonify({"error": "Invalid JSON body", "details": str(e)}), 400
    question = (data.get("question") or "").strip()
    correct = (data.get("correct_answer") or "").strip()
    if not question or not correct:
        return jsonify({"error": "question and correct_answer are required"}), 400

    # Build a concise prompt asking for an explanation
    prompt = (
        f"You are an expert tutor. The question is:\n{question}\nThe correct answer is: {correct}\n\n"
        "Give a concise and clear explanation for why this answer is correct, referencing the question and reasoning. "
        "Return only the explanation text."
    )

    if not GEMINI_API_KEY or requests is None:
        return jsonify({"error": "Server not configured with GEMINI_API_KEY or requests not available"}), 500

    try:
        resp = forward_to_gemini_rest(prompt)
    except Exception as e:
        print(f"Explain-answer Gemini call failed: {e}")
        return jsonify({"error": "Explain API failed", "details": str(e)}), 500

    explanation_text = None
    # Try common JSON/candidate shapes first
    try:
        j = resp.json()
        if isinstance(j, dict) and 'candidates' in j and isinstance(j['candidates'], list) and j['candidates']:
            content = j['candidates'][0].get('content') or j['candidates'][0]
            if isinstance(content, dict):
                parts = content.get('parts') or []
                if parts and isinstance(parts[0], dict):
                    explanation_text = parts[0].get('text') or parts[0].get('content')
    except Exception:
        pass

    if not explanation_text:
        explanation_text = resp.text if hasattr(resp, 'text') else str(resp)

    explanation_text = (explanation_text or "").strip()
    return jsonify({"explanation": explanation_text})


if __name__ == '__main__':
    app.run(port=3000)