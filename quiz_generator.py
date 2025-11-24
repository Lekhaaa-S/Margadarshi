import re
import json
import random
import unicodedata
from collections import Counter, defaultdict
from typing import List, Dict

# Offline NLP imports (ensure these packages installed in environment)
import fitz  # PyMuPDF (only if server-side PDF parsing desired)
import nltk
import logging
from nltk.corpus import wordnet as wn
from sklearn.feature_extraction.text import TfidfVectorizer

# Optional online fallback (OpenAI) - keep safe
try:
    import openai
except Exception:
    openai = None

# Try to download common NLTK resources if available; failures won't break the server.
for res in ("punkt", "averaged_perceptron_tagger", "wordnet", "stopwords"):
    try:
        nltk.download(res, quiet=True)
    except Exception:
        logging.getLogger(__name__).warning("Could not download NLTK resource: %s", res)

# Safe tokenizer/tagger wrappers: try NLTK, fall back to lightweight regex-based versions
def safe_sent_tokenize(text: str) -> List[str]:
    try:
        return nltk.sent_tokenize(text)
    except Exception:
        # Fallback: split on sentence-ending punctuation (basic, but robust)
        sents = re.split(r'(?<=[\.\!?])\s+', (text or "").strip())
        return [s.strip() for s in sents if s and s.strip()]


def safe_word_tokenize(text: str) -> List[str]:
    try:
        return nltk.word_tokenize(text)
    except Exception:
        # Fallback: capture words (incl. contractions)
        return re.findall(r"\b\w+(?:'\w+)?\b", text or "")


def safe_pos_tag(tokens: List[str]) -> List[tuple]:
    try:
        return nltk.pos_tag(tokens)
    except Exception:
        # Fallback: naive tagging (assume nouns) so downstream code still runs
        return [(t, 'NN') for t in tokens]

RANDOM_SEED = 42
random.seed(RANDOM_SEED)


def clean_input_text(raw_text: str) -> str:
    txt = unicodedata.normalize("NFKC", raw_text or "")
    lines = [ln.strip() for ln in txt.splitlines() if ln.strip()]
    lines = [ln for ln in lines if len(ln.split()) > 2]
    junk_patterns = [
        r"^\s*page\s*\d+\b",
        r"^\s*\d+\s*$",
        r"^\s*figure\s*\d+",
        r"^\s*fig\.\s*\d+",
        r"copyright\b",
        r"doi:",
        r"http[s]?:\/\/",
    ]
    filtered = []
    for ln in lines:
        low = ln.lower()
        if any(re.search(p, low) for p in junk_patterns):
            continue
        filtered.append(ln)
    counts = Counter(filtered)
    cleaned = [ln for ln in filtered if counts[ln] < max(3, len(filtered)//30)]
    out = " ".join(cleaned)
    out = re.sub(r"\s+", " ", out).strip()
    return out if out else raw_text


def chunk_text(text: str, max_words=300) -> List[str]:
    sents = nltk.sent_tokenize(text)
    chunks = []
    cur = []
    cur_words = 0
    for s in sents:
        w = len(s.split())
        if cur_words + w > max_words and cur:
            chunks.append(" ".join(cur))
            cur = [s]
            cur_words = w
        else:
            cur.append(s)
            cur_words += w
    if cur:
        chunks.append(" ".join(cur))
    return chunks


def extract_candidate_keywords(text: str, topn=40) -> List[str]:
    tokens = [w for w in nltk.word_tokenize(text) if w.isalpha()]
    tags = nltk.pos_tag(tokens)
    nouns = [w for w,t in tags if t.startswith("NN") and len(w)>3]
    freq = Counter([w.lower() for w in nouns])
    return [w for w,_ in freq.most_common(topn)]


def get_wordnet_distractors(word: str, k=3) -> List[str]:
    distractors = set()
    try:
        synsets = wn.synsets(word)
        for syn in synsets:
            for lemma in syn.lemmas():
                candidate = lemma.name().replace("_", " ")
                if candidate.lower() != word.lower() and candidate.isalpha():
                    distractors.add(candidate)
                if len(distractors) >= k:
                    return list(distractors)[:k]
    except Exception:
        pass
    return list(distractors)[:k]


def safe_sample(pool: List[str], k: int) -> List[str]:
    pool = list(dict.fromkeys([p for p in pool if p and isinstance(p, str)]))
    if not pool:
        return []
    if len(pool) >= k:
        return random.sample(pool, k)
    res = pool[:]
    while len(res) < k:
        res.append(random.choice(pool))
    return res[:k]


def generate_offline_quiz(text: str, amount: int = 10, difficulty: str = "medium") -> List[Dict]:
    text = clean_input_text(text)
    if not text or not text.strip():
        return []
    chunks = chunk_text(text, max_words=300) or [text]
    try:
        vectorizer = TfidfVectorizer(stop_words="english")
        tfidf = vectorizer.fit_transform(chunks)
        scores = tfidf.sum(axis=1).A1
        ranked = [c for _,c in sorted(zip(scores, chunks), key=lambda x: x[0], reverse=True)]
    except Exception:
        ranked = chunks
    cand_keywords = extract_candidate_keywords(text, topn=200)
    pos_pools = defaultdict(list)
    tokens = nltk.word_tokenize(text)
    tags = nltk.pos_tag(tokens)
    for w,t in tags:
        if not w.isalpha(): continue
        key = t[:2]
        pos_pools[key].append(w)
    questions = []
    used_sentences = set()
    for chunk in ranked:
        if len(questions) >= amount:
            break
        sents = nltk.sent_tokenize(chunk)
        sents = [s.strip() for s in sents if len(s.split()) >= 6]
        for sent in sents:
            if len(questions) >= amount:
                break
            if sent in used_sentences:
                continue
            used_sentences.add(sent)
            tags_sent = nltk.pos_tag(nltk.word_tokenize(sent))
            candidate = None
            for w,t in tags_sent:
                if t.startswith("NNP") and w.isalpha() and len(w)>2:
                    candidate = w
                    break
            if not candidate:
                for w,t in tags_sent:
                    if t.startswith("NN") and w.isalpha() and len(w)>3:
                        candidate = w
                        break
            if not candidate:
                for w,t in tags_sent:
                    if t.startswith("CD"):
                        candidate = w
                        break
            if not candidate:
                for kw in cand_keywords:
                    if re.search(r"\b" + re.escape(kw) + r"\b", sent, flags=re.IGNORECASE):
                        candidate = kw
                        break
            if not candidate:
                continue
            pattern = re.compile(r"\b" + re.escape(candidate) + r"\b", flags=re.IGNORECASE)
            question_text = pattern.sub("_____", sent, count=1)
            distractors = get_wordnet_distractors(candidate, k=3)
            if len(distractors) < 3:
                same_type_pool = [k for k in cand_keywords if k.lower() != candidate.lower()]
                distractors += safe_sample(same_type_pool, 3 - len(distractors))
            distractors = [d for d in distractors if d and d.lower() != candidate.lower()]
            distractors = safe_sample(distractors, 3)
            options = distractors + [candidate]
            random.shuffle(options)
            questions.append({
                "question": question_text,
                "options": options,
                "answer": candidate,
                "difficulty": difficulty,
                "context": sent[:320]
            })
    idx = 0
    while len(questions) < amount and idx < len(cand_keywords):
        kw = cand_keywords[idx]
        idx += 1
        m = re.search(r"([^.?!]*\b" + re.escape(kw) + r"\b[^.?!]*)[.?!]", text, flags=re.IGNORECASE)
        if not m:
            continue
        sent = m.group(1)
        pattern = re.compile(r"\b" + re.escape(kw) + r"\b", flags=re.IGNORECASE)
        qtxt = pattern.sub("_____", sent, count=1)
        distractors = get_wordnet_distractors(kw, k=3)
        if len(distractors) < 3:
            distractors += safe_sample([k for k in cand_keywords if k.lower() != kw.lower()], 3 - len(distractors))
        distractors = safe_sample(distractors, 3)
        options = distractors + [kw]
        random.shuffle(options)
        questions.append({
            "question": qtxt,
            "options": options,
            "answer": kw,
            "difficulty": difficulty,
            "context": sent[:320]
        })
    return questions[:amount]


# Optional online/OpenAI functions kept as-is (not changed)
def _extract_json_from_text(text: str) -> List[Dict]:
    try:
        data = json.loads(text)
        if isinstance(data, dict) and "quiz" in data:
            return data["quiz"]
        if isinstance(data, list):
            return data
    except Exception:
        pass
    m = re.search(r"(\{.*\})", text, flags=re.DOTALL)
    if m:
        s = m.group(1)
        try:
            data = json.loads(s)
            if isinstance(data, dict) and "quiz" in data:
                return data["quiz"]
            if isinstance(data, list):
                return data
        except Exception:
            pass
    m2 = re.search(r"(\[.*\])", text, flags=re.DOTALL)
    if m2:
        s = m2.group(1)
        try:
            data = json.loads(s)
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def generate_online_quiz(text: str, amount: int = 10, difficulty: str = "medium", openai_api_key: str = None) -> List[Dict]:
    if openai is None:
        raise RuntimeError("OpenAI package not available.")
    if not openai_api_key:
        raise RuntimeError("OpenAI API key not provided.")
    openai.api_key = openai_api_key
    max_chars = 4000
    trimmed = text[:max_chars]
    prompt = (
        f"You are an expert quiz generator. Create {amount} multiple-choice questions "
        f"(4 options each) from the provided document text. Difficulty: {difficulty}.\n"
        "Return strictly a JSON array of objects with keys: question, options (array of 4 strings), answer (string), difficulty.\n\n"
        "Document:\n"
        f"{trimmed}\n\n"
        "Important: Only return JSON (no explanatory text)."
    )
    resp = openai.ChatCompletion.create(
        model="gpt-3.5-turbo",
        messages=[
            {"role":"system","content":"You are a helpful assistant that only outputs JSON."},
            {"role":"user","content": prompt}
        ],
        temperature=0.3,
        max_tokens=1500,
        n=1
    )
    out = resp["choices"][0]["message"]["content"]
    parsed = _extract_json_from_text(out)
    if not parsed:
        return generate_offline_quiz(text, amount=amount, difficulty=difficulty)
    normalized = []
    for item in parsed[:amount]:
        q = item.get("question") if isinstance(item, dict) else None
        opts = item.get("options") if isinstance(item, dict) else None
        ans = item.get("answer") if isinstance(item, dict) else None
        diff = item.get("difficulty", difficulty) if isinstance(item, dict) else difficulty
        if not (q and opts and ans):
            continue
        if not isinstance(opts, list):
            opts = [str(opts)]
        if len(opts) < 4:
            more = safe_sample([w for w in extract_candidate_keywords(text) if w not in opts and w.lower()!=ans.lower()], 4-len(opts))
            opts = (opts + more)[:4]
        normalized.append({
            "question": q,
            "options": opts,
            "answer": ans,
            "difficulty": diff
        })
    if not normalized:
        return generate_offline_quiz(text, amount=amount, difficulty=difficulty)
    return normalized[:amount]
