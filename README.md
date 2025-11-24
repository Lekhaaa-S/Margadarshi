# Margadarshi

5mini - Quiz & Progress App

Run the Flask backend and open the frontend in a browser.

Prereqs
- Python 3.10+
- Install dependencies: `pip install -r requirements.txt`

Run

```powershell
pip install -r requirements.txt
python app.py
```

frontend: open http://127.0.0.1:5000/index.html

Notes
- If you set `GEMINI_API_KEY` in a `.env` file the server will attempt to use Gemini for better quiz generation when online. If no key is present or Gemini fails, the server uses a local generator.
- Progress sync is session-based. When not logged in the frontend falls back to localStorage and will auto-sync when a session exists / when you log in.
