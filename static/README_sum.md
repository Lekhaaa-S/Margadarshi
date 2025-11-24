# PDF Summarizer (Flask + Gemini)

This small project provides a frontend (static HTML/JS) to upload a PDF and request a summary with a given word length. A Flask backend accepts the upload, extracts text, calls a Gemini-style generative API (configured via `.env`), and returns the summary.

Setup
1. Create a Python virtual environment and activate it.

   PowerShell (Windows):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

2. Install dependencies:

```powershell
pip install -r requirements.txt
```

3. Create a `.env` file in the project root (next to `server.py`) and set your Gemini config. Use `.env.example` as a template.

Example `.env`:

```
GEMINI_API_URL=https://generative.googleapis.com/v1/models/text-bison-001:generateText
GEMINI_API_KEY=YOUR_REAL_KEY_HERE
```

Notes on Gemini endpoint
- Different Gemini/Google generative endpoints expect different request/response shapes and auth methods. The `server.py` uses a generic approach: it sends JSON {"prompt":..., "max_tokens":...} and an Authorization: Bearer header. If your provider expects `?key=` or a different JSON shape, update `GEMINI_API_URL` or `server.py` accordingly.

Running
1. Start the Flask server:

```powershell
python server.py
```

2. Serve the static frontend files (recommended) to avoid file:// CORS issues. From the project root you can run a simple static server:

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000/summarizer.html` in your browser.

Usage
- Choose a PDF and a summary length, click Generate Summary.
- The frontend will POST to `http://localhost:5000/summarize` and display the returned summary.

Troubleshooting
- If you get CORS or mixed-content errors, ensure you serve the frontend over http (not file://) and check the Flask CORS settings.
- If the Gemini call fails, inspect the printed error in the Flask console; adjust `GEMINI_API_URL` / auth method as needed for your provider.
