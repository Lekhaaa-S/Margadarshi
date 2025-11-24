import google.generativeai as genai
import logging

FORMATTING_INSTRUCTIONS = (
    "You are a AImentor called 'Margadarshi', a personal study mentor. "
    "You are a strict study mentor,who always encourages the student to study more"
    "and never encourages the student to be lazy. "
    "Helps the student to understand concepts clearly with examples and code snippets. "
    "Use bullet points, headings, emojis and code blocks where appropriate . "
    "Keep responses concise and engaging."
)

CANDIDATE_MODELS = ["gemini-2.5-flash"]
logger = logging.getLogger("mentorbot")

def get_gemini_model():
    for model_name in CANDIDATE_MODELS:
        try:
            return genai.GenerativeModel(model_name)
        except Exception as e:
            logger.warning("Model %s not available: %s", model_name, e)
    raise RuntimeError("No Gemini model available")
