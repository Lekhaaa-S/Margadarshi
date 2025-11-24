import os
import uuid
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.utils import secure_filename
import google.generativeai as genai
from dotenv import load_dotenv

# Local modules
from utils.extractors import extract_text_from_image, extract_text_from_pdf
from utils.ai_client import get_gemini_model, FORMATTING_INSTRUCTIONS

# Firebase
import firebase_admin
from firebase_admin import credentials, firestore

# ---------------- CONFIG ----------------
load_dotenv()
UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger("mentorbot")

# Firestore setup
if not firebase_admin._apps:
    # IMPORTANT: Ensure 'serviceAccountKey.json' is present in your project root
    cred = credentials.Certificate("serviceAccountKey.json") 
    firebase_admin.initialize_app(cred)
db = firestore.client()

# Gemini config
GENAI_KEY = os.getenv("GEMINI_API_KEY")
if not GENAI_KEY:
    raise RuntimeError("GEMINI_API_KEY not found in .env")
genai.configure(api_key=GENAI_KEY)

app = Flask(__name__, static_url_path='/uploads', static_folder='uploads')
CORS(app)

# ------------- UTIL: Firestore Chat Save -------------
def save_chat_to_firestore(user_id, message, reply, file_meta=None):
    """Save user chat and AI response to Firestore. Returns the document ID."""
    doc_ref = db.collection("users").document(user_id).collection("chats").document()
    doc_ref.set({
        "message": message,
        "reply": reply,
        "fileMeta": file_meta,
        "timestamp": firestore.SERVER_TIMESTAMP
    })
    logger.info("Chat saved for user %s with ID %s", user_id, doc_ref.id)
    return doc_ref.id


@app.route('/saveChat', methods=['POST'])
def save_chat():
    """Generic endpoint to save a chat pair (message + reply) from the client.

    This is useful for persisting AI-only messages (welcome prompts) or client-side
    generated messages that weren't routed through the regular `/chat` or upload
    endpoints. Expects JSON: { user_id, message, reply, fileMeta? }
    """
    try:
        data = request.get_json(force=True)
    except Exception as e:
        return jsonify({'error': 'Invalid JSON', 'details': str(e)}), 400

    user_id = data.get('user_id', 'anonymous')
    message = data.get('message', '')
    reply = data.get('reply', '')
    file_meta = data.get('fileMeta', None)

    try:
        doc_id = save_chat_to_firestore(user_id, message, reply, file_meta)
        return jsonify({'status': 'saved', 'doc_id': doc_id}), 200
    except Exception as e:
        logger.exception('Failed to save chat via saveChat endpoint')
        return jsonify({'error': str(e)}), 500

# ------------- ROUTES -------------

@app.route("/chat", methods=["POST"])
def handle_chat():
    """Handle normal chat text."""
    data = request.get_json(force=True)
    user_id = data.get("user_id", "anonymous")
    message = data.get("text", "").strip()

    if not message:
        return jsonify({"error": "Empty message"}), 400

    # --- Fetch user profile ---
    profile_text = ""
    if user_id != "anonymous":
        doc_ref = db.collection("users").document(user_id)
        doc_snap = doc_ref.get()
        if doc_snap.exists:
            profile = doc_snap.to_dict()
            name = profile.get("name", "")
            exam_goal = profile.get("examGoal", "")
            future_aim = profile.get("futureAim", "")
            hobbies = profile.get("hobbies", "")
    
            profile_text = (
                f"Student Name: {name}\n"
                f"Exam Goal: {exam_goal}\n"
                f"Future Aim: {future_aim}\n"
                f"Hobbies: {hobbies}\n"
            )

    try:
        model = get_gemini_model()
        prompt = f"{FORMATTING_INSTRUCTIONS}\n\n"
        prompt += f"{profile_text}"
        prompt += f"User message: {message}"

        resp = model.generate_content(prompt)
        reply = getattr(resp, "text", "⚠️ No AI response")

        # Save chat and get document ID
        doc_id = save_chat_to_firestore(user_id, message, reply)

        # Return the doc_id to the frontend
        return jsonify({"reply": reply, "doc_id": doc_id})
    except Exception as e:
        logger.exception("Chat error")
        return jsonify({"error": str(e)}), 500


@app.route("/uploadImage", methods=["POST"])
def upload_image():
    """Handle image upload and question."""
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400

    f = request.files["file"]
    question = request.form.get("question", "")
    user_id = request.form.get("user_id", "anonymous")

    filename = secure_filename(f.filename)
    unique_name = f"{uuid.uuid4().hex}_{filename}"
    save_path = os.path.join(UPLOAD_FOLDER, unique_name)
    f.save(save_path)

    extracted_text = extract_text_from_image(save_path)

    model = get_gemini_model()
    prompt = (
        f"{FORMATTING_INSTRUCTIONS}\n\n"
        f"User uploaded an image and asked: {question or 'Summarize the image'}\n"
        f"Extracted Text:\n{extracted_text}"
    )
    resp = model.generate_content(prompt)
    reply = getattr(resp, "text", "⚠️ No AI response")

    file_url = f"/uploads/{unique_name}"  # this is the browser-accessible URL

    doc_id = save_chat_to_firestore(
        user_id,
        f"[Image: {filename}] {question}",
        reply,
        {"name": filename, "type": f.content_type, "url": file_url})

    return jsonify({"reply": reply, "filename": filename, "doc_id": doc_id})


@app.route("/uploadPDF", methods=["POST"])
def upload_pdf():
    """Handle PDF upload."""
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400

    f = request.files["file"]
    question = request.form.get("question", "")
    user_id = request.form.get("user_id", "anonymous")

    filename = secure_filename(f.filename)
    unique_name = f"{uuid.uuid4().hex}_{filename}"
    save_path = os.path.join(UPLOAD_FOLDER, unique_name)
    f.save(save_path)

    extracted_text = extract_text_from_pdf(save_path)

    model = get_gemini_model()
    prompt = (
        f"{FORMATTING_INSTRUCTIONS}\n\n"
        f"User uploaded a document and asked: {question or 'Summarize this PDF'}\n"
        f"Document Content:\n{extracted_text}"
    )
    resp = model.generate_content(prompt)
    reply = getattr(resp, "text", "⚠️ No AI response")

    file_url = f"/uploads/{unique_name}"

    doc_id = save_chat_to_firestore(
        user_id,
        f"[PDF: {filename}] {question}",
        reply,
        {"name": filename, "type": f.content_type, "url": file_url} )
    return jsonify({"reply": reply, "filename": filename, "doc_id": doc_id})


@app.route("/getChats/<user_id>", methods=["GET"])
def get_chats(user_id):
    """Retrieve previous chats for a user and return as JSON list."""
    try:
        # Chats are ordered by timestamp ascending (oldest first)
        chats_ref = db.collection("users").document(user_id).collection("chats").order_by("timestamp")
        docs = chats_ref.stream()
        chats = []
        for d in docs:
            data = d.to_dict()
            data["doc_id"] = d.id # Include the document ID
            # Normalize timestamp to ISO string when possible
            ts = data.get("timestamp")
            if ts is not None:
                try:
                    data["timestamp"] = ts.isoformat()
                except Exception:
                    try:
                        data["timestamp"] = str(ts)
                    except Exception:
                        data["timestamp"] = None
            chats.append(data)
        return jsonify(chats)
    except Exception as e:
        logger.exception("Error fetching chats for user %s", user_id)
        return jsonify({"error": str(e)}), 500


@app.route("/deleteChat/<user_id>/<doc_id>", methods=["DELETE"])
def delete_chat(user_id, doc_id):
    """Delete a single chat message document by doc_id (new endpoint)."""
    try:
        db.collection("users").document(user_id).collection("chats").document(doc_id).delete()
        logger.info("Deleted chat document %s for user %s", doc_id, user_id)
        return jsonify({"status": "deleted", "doc_id": doc_id}), 200
    except Exception as e:
        logger.error("Failed to delete chat: %s", e)
        return jsonify({"error": f"Failed to delete chat: {e}"}), 500

@app.route("/clearAllChats/<user_id>", methods=["DELETE"])
def clear_all_chats(user_id):
    """Delete all chat documents for a user (new endpoint)."""
    try:
        collection_ref = db.collection("users").document(user_id).collection("chats")
        docs = list(collection_ref.stream())
        deleted_count = 0
        for doc in docs:
            doc.reference.delete()
            deleted_count += 1
        return jsonify({"status": f"Cleared {deleted_count} chats"}), 200
    except Exception as e:
        logger.error("Failed to clear all chats: %s", e)
        return jsonify({"error": f"Failed to clear all chats: {e}"}), 500


# ---------------- MAIN ----------------
if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)