#app.py
import os
import json
import socket
import logging
import requests
import time
from flask import Flask, request, jsonify, send_from_directory, session, redirect
from flask_cors import CORS
from dotenv import load_dotenv


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_FOLDER = os.path.join(BASE_DIR, "static")
app = Flask(__name__, static_folder=STATIC_FOLDER, static_url_path='')
app.secret_key = 'replace_this_with_a_secure_random_key'
CORS(app, supports_credentials=True)

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("quiz-backend")


def user_file(user_id):
    return f'progress_{user_id}.json'


@app.route('/')
def index():
    # Serve the public homepage at the site root so visiting the IP shows
    # the main marketing/home page rather than immediately loading the quiz UI.
    # The quiz UI stays available at `/quiz.html` and the quiz app paths still
    # function unchanged.
    return send_from_directory(app.static_folder, 'home.html')


@app.route('/service-worker.js')
def service_worker_file():
    """Serve the service-worker from the app root and set Service-Worker-Allowed to '/'.
    This ensures the worker can claim clients at the site root and makes the file
    explicitly reachable at /service-worker.js (avoids subtle static routing issues).
    """
    try:
        resp = send_from_directory(app.static_folder, 'service-worker.js')
        # Allow the worker to control the whole origin
        resp.headers['Service-Worker-Allowed'] = '/'
        logger.info('Serving /service-worker.js to client')
        return resp
    except Exception as e:
        logger.exception('Error serving service-worker.js: %s', e)
        return ('', 404)


@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory(app.static_folder, filename)


@app.route('/favicon.ico')
def favicon():
    fav_path = os.path.join(app.static_folder, 'favicon.ico')
    if os.path.exists(fav_path):
        return send_from_directory(app.static_folder, 'favicon.ico')
    return ('', 204)


@app.route('/login', methods=['POST'])
def login():
    data = request.get_json(force=True)
    username = data.get('username', '')
    if username:
        session['user_id'] = username
        return jsonify({'status': 'logged in'})
    return jsonify({'error': 'Username required'}), 400


@app.route('/logout')
def logout():
    session.clear()
    return jsonify({'status': 'logged out'})


# --- Root-level aliases for convenience ---
@app.route('/chat')
def chat_root_redirect():
    # Redirect root-level /chat to the namespaced chat app
    # Serve the root static chat page directly so the browser can load
    # the chat UI while APIs remain namespaced under /chat.
    return send_from_directory(app.static_folder, 'chat.html')


@app.route('/chat.html')
def chat_html_alias():
    # Serve chat.html from the root static folder (avoid redirecting into /chat)
    return send_from_directory(app.static_folder, 'chat.html')


@app.route('/studyroom1.html')
def study_html_alias():
    # Serve studyroom1.html directly from the root static folder
    return send_from_directory(app.static_folder, 'studyroom1.html')


@app.route('/study')
def study_root_redirect():
    # Serve the studyroom UI from the root static folder; APIs remain under /study
    return send_from_directory(app.static_folder, 'studyroom1.html')


@app.route('/api/sync-progress', methods=['POST'])
def sync_progress():
    # If no session, return non-error payload so clients can gracefully fallback to local storage
    if 'user_id' not in session:
        return jsonify({'status': 'no-session', 'logged_in': False}), 200
    data = request.get_json(force=True)
    user_id = session['user_id']
    fname = user_file(user_id)
    existing = {"subjects": [], "quizzes": []}
    if os.path.exists(fname):
        with open(fname, 'r') as f:
            try:
                existing = json.load(f)
            except:
                pass
    # Update subjects fully from client (overwrite)
    if "subjects" in data:
        existing["subjects"] = data["subjects"]

    # Upsert quizzes by quizName (overwrite existing or add new)
    for record in data.get("quizzes", []):
        quizName = record.get("quizName")
        if not quizName:
            continue
        idx = next((i for i, q in enumerate(existing["quizzes"]) if q.get("quizName") == quizName), -1)
        if idx >= 0:
            existing["quizzes"][idx] = record
        else:
            existing["quizzes"].append(record)

    with open(fname, 'w') as f:
        json.dump(existing, f, indent=2)

    return jsonify({'status': 'success'})


@app.route('/api/user-progress', methods=['GET'])
def user_progress():
    if 'user_id' not in session:
        # Return an explicit non-error payload so the frontend can gracefully
        # fallback to localStorage without noisy 401 errors.
        return jsonify({'logged_in': False, 'subjects': [], 'quizzes': []}), 200
    fname = user_file(session['user_id'])
    if os.path.exists(fname):
        with open(fname, 'r') as f:
            data = json.load(f)
            return jsonify(data)
    return jsonify({"subjects": [], "quizzes": []})


@app.route('/api/delete-quiz/<quiz_name>', methods=['DELETE'])
def delete_quiz(quiz_name):
    if 'user_id' not in session:
        return jsonify({'error': 'not logged in'}), 401
    user_id = session['user_id']
    fname = user_file(user_id)
    if not os.path.exists(fname):
        return jsonify({'error': 'no progress found'}), 404
    with open(fname, 'r') as f:
        data = json.load(f)

    quizzes = data.get("quizzes", [])
    new_quizzes = [q for q in quizzes if q.get("quizName") != quiz_name]

    if len(new_quizzes) == len(quizzes):
        return jsonify({'error': 'quiz not found'}), 404

    data["quizzes"] = new_quizzes
    with open(fname, 'w') as f:
        json.dump(data, f, indent=2)
    return jsonify({'status': 'deleted'})


def is_online(host="8.8.8.8", port=53, timeout=2) -> bool:
    try:
        socket.setdefaulttimeout(timeout)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.connect((host, port))
        return True
    except Exception:
        return False


from quiz_generator import generate_offline_quiz, clean_input_text


def generate_online_quiz_gemini(text: str, amount: int = 10, difficulty: str = "medium", gemini_api_key: str = None):
    if not gemini_api_key:
        raise ValueError("Missing GEMINI_API_KEY")
    prompt = f"""
You are an expert quiz maker. Generate exactly {amount} multiple-choice questions (MCQs)
from the following study material. Each question must include:
- "question": concise, clear question text
- "options": an array of exactly 4 plausible answer strings
- "answer": the single correct option string (must be one of the options)
- "difficulty": one of "easy", "medium", "hard" matching the requested difficulty


Return ONLY a valid JSON array (no explanation, no extra text) in this exact shape:
[
  {{
    "question": "Question text",
    "options": ["A", "B", "C", "D"],
    "answer": "B",
    "difficulty": "{difficulty}"
  }},
  ...
]


Study material:
{text[:6000]}
""".strip()
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": gemini_api_key
    }
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt}
                ]
            }
        ]
    }
    max_attempts = 3
    base_backoff = 1.0
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            logger.info(f"Gemini request attempt {attempt}/{max_attempts}")
            resp = requests.post(url, headers=headers, json=payload, timeout=90)
            resp.raise_for_status()
            data = resp.json()
            candidates = data.get("candidates", [])
            if not candidates:
                raise RuntimeError("Gemini response contains no candidates")
            content = candidates[0].get("content", {})
            parts = content.get("parts", [])
            if not parts:
                raise RuntimeError("Gemini response content.parts missing")
            text_response = parts[0].get("text", "")
            if not isinstance(text_response, str) or not text_response.strip():
                raise RuntimeError("Gemini returned empty text response")
            try:
                quiz = json.loads(text_response)
            except Exception as p_err:
                import re
                m = re.search(r"(\[.*\])", text_response, flags=re.DOTALL)
                if m:
                    try:
                        quiz = json.loads(m.group(1))
                    except Exception:
                        raise RuntimeError("Failed to parse JSON from Gemini output") from p_err
                else:
                    raise RuntimeError("No JSON array found in Gemini output") from p_err
            if not isinstance(quiz, list):
                raise RuntimeError("Gemini returned JSON that is not a list")
            normalized = []
            for item in quiz[:amount]:
                if not isinstance(item, dict):
                    continue
                q = item.get("question")
                opts = item.get("options") or item.get("choices") or item.get("incorrect_answers")
                ans = item.get("answer")
                diff = item.get("difficulty", difficulty)
                if not q or not ans:
                    continue
                if not isinstance(opts, list):
                    continue
                opts = opts[:4]
                if len(opts) < 4:
                    while len(opts) < 4:
                        opts.append(f"Option {len(opts)+1}")
                if ans not in opts:
                    opts[-1] = ans
                normalized.append({
                    "question": str(q),
                    "options": [str(o) for o in opts],
                    "answer": str(ans),
                    "difficulty": str(diff)
                })
            if not normalized:
                raise RuntimeError("Gemini produced no valid quiz items")
            return normalized[:amount]
        except Exception as exc:
            last_err = exc
            logger.warning(f"Gemini attempt {attempt} failed: {exc}")
            if attempt < max_attempts:
                sleep_for = base_backoff * (2 ** (attempt - 1))
                logger.info(f"Retrying after {sleep_for} seconds...")
                time.sleep(sleep_for)
            else:
                logger.error("Gemini generation exhausted retries")
    raise RuntimeError(f"Gemini generation failed after {max_attempts} attempts: {last_err}")


def generate_online_quiz_about_topic(topic: str, amount: int = 10, difficulty: str = "medium", gemini_api_key: str = None):
    """
    Generate multiple-choice questions strictly about a short named topic.
    This helper calls Gemini with a prompt that instructs it to return only a JSON array
    of MCQ objects closely tied to the provided topic string.
    """
    if not gemini_api_key:
        raise ValueError("Missing GEMINI_API_KEY")
    prompt_template = """
You are an expert quiz maker. Generate exactly {amount} multiple-choice questions (MCQs)
STRICTLY about the topic: "{topic}". Every question MUST include the topic word "{topic}" either in the question text or in the correct answer. Do NOT include any questions unrelated to the topic. If you cannot generate enough, repeat or rephrase questions about the topic until you reach {amount}.

Each question must include:
- "question": concise, clear question text that mentions the topic word "{topic}" OR where the correct answer contains the topic word
- "options": an array of exactly 4 plausible answer strings
- "answer": the single correct option string (must be one of the options)
- "difficulty": one of "easy", "medium", "hard" matching the requested difficulty

Return ONLY a valid JSON array (no explanation, no extra text) in this exact shape:
[
    {{
        "question": "Question text (must mention '{topic}' in the question OR the correct answer)",
        "options": ["A", "B", "C", "D"],
        "answer": "B",
        "difficulty": "{difficulty}"
    }},
    ...
]

Topic: {topic}
"""
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": gemini_api_key
    }
    import re
    # We'll attempt multiple times to get strictly topic-related questions.
    max_attempts = 8
    last_err = None
    # Build topic keywords for validation (split on non-word characters)
    import re as _re
    topic_keywords = [k.lower() for k in _re.split(r"\W+", topic) if k]

    def _item_matches_topic(item):
        # Accept if topic keyword appears in question or answer
        try:
            q = str(item.get('question', '')).lower()
            a = str(item.get('answer', '')).lower()
            for kw in topic_keywords:
                if kw and (kw in q or kw in a):
                    return True
        except Exception:
            pass
        return False

    for attempt in range(1, max_attempts + 1):
        prompt = prompt_template.format(amount=amount, topic=topic, difficulty=difficulty)
        payload = {"contents": [{"parts": [{"text": prompt}]}]}
        try:
            logger.info(f"Gemini topic request attempt {attempt}/{max_attempts}")
            resp = requests.post(url, headers=headers, json=payload, timeout=90)
            resp.raise_for_status()
            data = resp.json()
            candidates = data.get("candidates", [])
            if not candidates:
                raise RuntimeError("Gemini response contains no candidates")
            content = candidates[0].get("content", {})
            parts = content.get("parts", [])
            if not parts:
                raise RuntimeError("Gemini response content.parts missing")
            text_response = parts[0].get("text", "")
            if not isinstance(text_response, str) or not text_response.strip():
                raise RuntimeError("Gemini returned empty text response")
            try:
                quiz = json.loads(text_response)
            except Exception as p_err:
                m = re.search(r"(\[.*\])", text_response, flags=re.DOTALL)
                if m:
                    try:
                        quiz = json.loads(m.group(1))
                    except Exception:
                        raise RuntimeError("Failed to parse JSON from Gemini output") from p_err
                else:
                    raise RuntimeError("No JSON array found in Gemini output") from p_err
            if not isinstance(quiz, list):
                raise RuntimeError("Gemini returned JSON that is not a list")
            # Normalize and validate items strictly: require topic word in question or answer
            normalized = []
            for item in quiz:
                if not isinstance(item, dict):
                    continue
                q = item.get("question")
                opts = item.get("options") or item.get("choices") or item.get("incorrect_answers")
                ans = item.get("answer")
                diff = item.get("difficulty", difficulty)
                if not q or not ans:
                    continue
                if not isinstance(opts, list):
                    continue
                # Check topic presence in question or answer using keywords
                if topic_keywords and not _item_matches_topic(item):
                    continue
                opts = opts[:4]
                if len(opts) < 4:
                    while len(opts) < 4:
                        opts.append(f"Option {len(opts)+1}")
                if ans not in opts:
                    opts[-1] = ans
                normalized.append({
                    "question": str(q),
                    "options": [str(o) for o in opts],
                    "answer": str(ans),
                    "difficulty": str(diff)
                })
            if len(normalized) >= amount:
                return normalized[:amount]
            last_err = f"Gemini produced only {len(normalized)} valid topic questions (need {amount})"
            logger.warning(last_err)
            if attempt < max_attempts:
                logger.info("Waiting 5 seconds before retrying...")
                import time
                time.sleep(5)
        except Exception as exc:
            last_err = exc
            logger.warning(f"Gemini topic attempt {attempt} failed: {exc}")
            if attempt < max_attempts:
                logger.info("Waiting 5 seconds before retrying...")
                import time
                time.sleep(5)
            else:
                logger.error("Gemini topic generation exhausted retries")
    raise RuntimeError(f"Gemini topic generation failed after {max_attempts} attempts: {last_err}")


@app.route("/generate-quiz", methods=["POST"])
def generate_quiz():
    try:
        data = request.get_json(force=True)
    except Exception as e:
        return jsonify({"error": "Invalid JSON body", "details": str(e)}), 400
    text = (data.get("text") or "").strip()
    difficulty = (data.get("difficulty") or "medium").strip().lower()
    try:
        amount = int(data.get("amount", 10))
    except Exception:
        return jsonify({"error": "amount must be an integer"}), 400
    if difficulty not in {"easy", "medium", "hard"}:
        return jsonify({"error": "difficulty must be one of easy, medium, hard"}), 400
    if amount <= 0 or amount > 100:
        return jsonify({"error": "amount must be 1..100"}), 400
    if not text:
        return jsonify({"error": "No text provided from PDF"}), 400
    cleaned = clean_input_text(text)
    is_topic = bool(data.get("is_topic", False))
    # Use only the GEMINI_API_KEY from the server environment (do not accept client-supplied keys)
    env_key = os.getenv("GEMINI_API_KEY", "").strip()
    gemini_key = env_key
    online_ok = bool(gemini_key) and is_online()
    try:
        mode = None
        if online_ok:
            if is_topic:
                logger.info("Online topic-mode: Using Gemini topic generator")
                # For topic-mode, the `text` field is expected to be a short topic string
                try:
                    quiz = generate_online_quiz_about_topic(text, amount=amount, difficulty=difficulty, gemini_api_key=gemini_key)
                    mode = 'ai-verified'
                except Exception as topic_exc:
                    logger.warning(f"Gemini topic generation failed or produced no valid questions: {topic_exc}")
                    logger.info("Falling back to offline topic generator")
                    quiz = generate_offline_quiz(text, amount=amount, difficulty=difficulty)
                    mode = 'offline-fallback'
            else:
                logger.info("Online mode: Using Gemini API for quiz generation")
                quiz = generate_online_quiz_gemini(cleaned, amount=amount, difficulty=difficulty, gemini_api_key=gemini_key)
                mode = 'ai'
        else:
            logger.info("Offline mode: Using local quiz generator")
            quiz = generate_offline_quiz(cleaned, amount=amount, difficulty=difficulty)
            mode = 'offline'
        return jsonify({"quiz": quiz, "mode": mode})
    except Exception as e:
        logger.exception("Quiz generation failed (online attempt)")
        try:
            logger.info("Falling back to offline generator")
            quiz = generate_offline_quiz(cleaned, amount=amount, difficulty=difficulty)
            return jsonify({"quiz": quiz, "mode": "offline-fallback"})
        except Exception as e2:
            logger.exception("Offline fallback also failed")
            return jsonify({"error": "Quiz generation failed", "details": str(e2)}), 500


@app.route("/explain-answer", methods=["POST"])
def explain_answer():
    try:
        data = request.get_json(force=True)
    except Exception as e:
        return jsonify({"error": "Invalid JSON body", "details": str(e)}), 400
    question = (data.get("question") or "").strip()
    correct = (data.get("correct_answer") or "").strip()
    if not question or not correct:
        return jsonify({"error": "question and correct_answer are required"}), 400
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    online_ok = bool(gemini_key) and is_online()
    if online_ok:
        prompt = f"""
You are an expert tutor. The question is:
{question}
The correct answer is: {correct}


Give a concise and clear explanation for why this answer is correct, referencing the question and reasoning. Do not return any extra text or apologies.
"""
        url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": gemini_key
        }
        payload = {
            "contents": [
                {"parts": [{"text": prompt}]}
            ]
        }

        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=40)
            resp.raise_for_status()
            data = resp.json()
            candidates = data.get("candidates", [])
            if candidates and candidates[0].get("content", {}).get("parts", []):
                explanation = candidates[0]["content"]["parts"][0].get("text", "").strip()
                if explanation:
                    return jsonify({"explanation": explanation})
        except Exception as err:
            logger.warning(f"Gemini explanation failed: {err}")
    # Fallback (or offline) explanation
    explanation = (
        f"The correct answer is '{correct}' because it best completes or matches the key "
        f"fact referenced in the prompt. Look for contextual cues around the blank or "
        f"the entity mentioned in the sentence to verify alignment with '{correct}'."
    )
    return jsonify({"explanation": explanation})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
