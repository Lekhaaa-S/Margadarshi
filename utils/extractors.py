import fitz  # PyMuPDF
from PIL import Image
import pytesseract
import logging

logger = logging.getLogger("mentorbot")

def extract_text_from_pdf(path):
    try:
        doc = fitz.open(path)
        text = "\n".join(page.get_text() for page in doc)
        return text.strip()
    except Exception as e:
        logger.error("PDF extract failed: %s", e)
        return ""

def extract_text_from_image(path):
    try:
        return pytesseract.image_to_string(Image.open(path)).strip()
    except Exception as e:
        logger.error("Image OCR failed: %s", e)
        return ""
