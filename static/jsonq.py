# jsonq.py
"""
Offline-first full-document quiz generator.

Pipeline:
  - Accepts raw_text (prefer page separators as '\f' if possible)
  - Detects & removes repeated headers/footers, page numbers, TOC-like lines
  - Strips bullets/emojis and normalizes
  - Segments into chunks and ranks them (TF-IDF if available)
  - Builds global keyword pool
  - Generates cloze-style questions with rewriting heuristics
  - Builds distractors from WordNet (if present) or doc keywords
  - Post-filters low-quality questions, ensures coverage across doc
"""

import re
import unicodedata
import random
from collections import Counter

# Optional PDF reader
try:
    import fitz
except Exception:
    fitz = None

# Optional NLP libs
try:
    import nltk
    from nltk.corpus import wordnet as wn
    HAVE_NLTK = True
except Exception:
    nltk = None
    wn = None
    HAVE_NLTK = False

# Optional TF-IDF ranking
try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    HAVE_SKLEARN = True
except Exception:
    TfidfVectorizer = None
    HAVE_SKLEARN = False

# ---------------- Utilities ----------------
_sentence_splitter_re = re.compile(r'(?<=[.!?])\s+')
_word_splitter_re = re.compile(r"\b[a-zA-Z]{2,}\b")

def simple_sent_tokenize(text):
    return [s.strip() for s in _sentence_splitter_re.split(text) if s.strip()]

def simple_word_tokenize(text):
    return _word_splitter_re.findall(text.lower())

# Basic stopwords fallback
FALLBACK_STOPWORDS = {
    "the","and","for","that","with","this","from","which","when","are","were",
    "also","have","has","had","but","not","can","use","used","using","been",
    "into","about","between","other","such","a","an","in","on","at","by","of","to","is","it","its","this","these","those"
}

def get_stopwords():
    if HAVE_NLTK:
        try:
            from nltk.corpus import stopwords
            return set(stopwords.words("english"))
        except Exception:
            pass
    return FALLBACK_STOPWORDS

STOPWORDS = get_stopwords()

# Remove emojis & bullets & weird characters
_EMOJI_RE = re.compile(
    "[" 
    "\U0001F300-\U0001F6FF"  # pictographs
    "\u2600-\u26FF"          # miscellaneous symbols
    "\u2700-\u27BF"          # dingbats
    "]", flags=re.UNICODE)

_BULLET_RE = re.compile(r'^[\s\-\u2022\u25CF\u25CB\u25A0\u25B2\u2023\u2043]+')

def strip_noise_chars(s: str) -> str:
    s = _EMOJI_RE.sub('', s)
    s = s.replace('\xa0', ' ')
    # strip leading bullets
    s = re.sub(r'^[\s\-\u2022\u25CF\u25CB\u25A0\u25B2\u2023\u2043]+', '', s)
    # trim
    s = s.strip()
    return s

def normalize_line(line: str) -> str:
    ln = unicodedata.normalize("NFKC", line).strip()
    ln = strip_noise_chars(ln)
    ln = re.sub(r'\s+', ' ', ln)
    return ln

# ---------------- Header/footer detection ----------------
def split_into_segments(raw_text, seg_chars=3500):
    """Split into segments (simulate pages) if no page breaks sent by frontend."""
    text = raw_text.strip()
    if not text:
        return []
    # If user provides explicit form-feed separators, honor them
    if '\f' in text:
        return [seg for seg in text.split('\f') if seg.strip()]
    # If many double newlines exist, split on them
    if '\n\n' in text:
        return [seg for seg in text.split('\n\n') if seg.strip()]
    # Otherwise split into fixed-size segments
    segments = []
    i = 0
    L = len(text)
    while i < L:
        segments.append(text[i: i + seg_chars])
        i += seg_chars
    return segments

def extract_lines_from_segment(seg):
    seg = seg.replace('\r', '\n')
    if '\n' in seg:
        lines = [normalize_line(l) for l in seg.split('\n') if l.strip()]
    else:
        lines = [normalize_line(s) for s in simple_sent_tokenize(seg) if s.strip()]
    return lines

def detect_repeated_lines(segments, threshold_frac=0.30):
    per_seg_sets = []
    for seg in segments:
        lines = extract_lines_from_segment(seg)
        per_seg_sets.append(set(lines))
    freq = Counter()
    for s in per_seg_sets:
        for line in s:
            freq[line] += 1
    repeated = set()
    seg_count = max(1, len(per_seg_sets))
    for line, cnt in freq.items():
        if cnt / seg_count >= threshold_frac:
            repeated.add(line)
    return repeated

def looks_like_page_number(line):
    if re.match(r'^\s*\d+\s*$', line):
        return True
    if re.match(r'^\s*(page|pg|p)\.?\s*\d+\s*$', line, flags=re.I):
        return True
    if re.match(r'^\(\d+\)$', line.strip()):
        return True
    return False

def looks_like_toc_or_range(line):
    if re.search(r'\.{3,}', line):  # "........"
        return True
    if re.search(r'\bcontents\b', line, flags=re.I):
        return True
    if re.match(r'^\s*\d+(\.\d+){0,3}\s*[-–—]\s*\d+(\.\d+){0,3}\s*$', line):
        return True
    return False

def looks_like_header_token(line):
    if re.search(r'\b[A-Z]{2,}\d{2,}\b', line):  # course codes like BCS502
        return True
    if re.search(r'\b(syllabus|module|chapter|textbook|contents|index|introduction|overview|syllabus)\b', line, flags=re.I):
        return True
    # avoid lines that are mostly uppercase words (likely headings)
    words = re.findall(r'\b[A-Za-z]+\b', line)
    if words:
        up = sum(1 for w in words if w.isupper())
        if up >= max(1, len(words)//2):
            return True
    return False

def clean_and_merge_pages(raw_text):
    segments = split_into_segments(raw_text, seg_chars=3500)
    if not segments:
        return ""
    repeated = detect_repeated_lines(segments, threshold_frac=0.30)
    kept = []
    for seg in segments:
        lines = extract_lines_from_segment(seg)
        for raw_line in lines:
            line = normalize_line(raw_line)
            if not line:
                continue
            if line in repeated:
                continue
            if looks_like_page_number(line):
                continue
            if looks_like_toc_or_range(line):
                continue
            if looks_like_header_token(line):
                continue
            # drop very short lines
            if len(simple_word_tokenize(line)) <= 3:
                continue
            kept.append(line)
    merged = " ".join(kept)
    merged = unicodedata.normalize("NFKC", merged)
    merged = re.sub(r'\s+', ' ', merged).strip()
    return merged

# ---------------- chunking and ranking ----------------
def chunk_text(text, chunk_size_words=300):
    if HAVE_NLTK:
        try:
            sents = nltk.sent_tokenize(text)
        except Exception:
            sents = simple_sent_tokenize(text)
    else:
        sents = simple_sent_tokenize(text)
    chunks, cur, count = [], [], 0
    for s in sents:
        cur.append(s)
        count += len(simple_word_tokenize(s))
        if count >= chunk_size_words:
            chunks.append(" ".join(cur))
            cur, count = [], 0
    if cur:
        chunks.append(" ".join(cur))
    return chunks

def rank_chunks(chunks):
    if HAVE_SKLEARN and len(chunks) > 0:
        try:
            vec = TfidfVectorizer(stop_words='english')
            tfidf = vec.fit_transform(chunks)
            scores = tfidf.sum(axis=1)
            if hasattr(scores, "A1"):
                score_list = scores.A1
            else:
                score_list = [float(s) for s in scores]
            ranked = sorted(zip(score_list, chunks), reverse=True)
            return [c for _, c in ranked]
        except Exception:
            pass
    # fallback ranking: length & keyword density
    scored = []
    for c in chunks:
        words = simple_word_tokenize(c)
        kw_count = sum(1 for w in words if w not in STOPWORDS and len(w) > 3)
        scored.append((len(words) + kw_count * 2, c))
    scored.sort(reverse=True)
    return [c for _, c in scored]

# ---------------- keyword extraction ----------------
def extract_keywords_for_chunk(chunk, topn=12):
    if HAVE_NLTK:
        try:
            tokens = [w for w in nltk.word_tokenize(chunk) if w.isalpha()]
            tags = nltk.pos_tag(tokens)
            nouns = [w for w, t in tags if t.startswith("NN") and len(w) > 3]
            freq = Counter(nouns)
            return [w for w, _ in freq.most_common(topn)]
        except Exception:
            pass
    words = simple_word_tokenize(chunk)
    candidates = [w for w in words if w not in STOPWORDS and len(w) > 3]
    freq = Counter(candidates)
    return [w for w, _ in freq.most_common(topn)]

# ---------------- distractors ----------------
def _simple_singular(word):
    # tiny heuristic to reduce plural/singular confusion
    if word.endswith('ies'):
        return word[:-3] + 'y'
    if word.endswith('s') and len(word) > 4:
        return word[:-1]
    return word

def get_distractors(correct_word, pool_keywords, k=3):
    distractors = []
    if wn is not None:
        try:
            synsets = wn.synsets(correct_word)
            for syn in synsets:
                for lemma in syn.lemmas():
                    w = lemma.name().replace('_', ' ')
                    if w.lower() != correct_word.lower() and w not in distractors:
                        distractors.append(w)
                    if len(distractors) >= k:
                        return distractors[:k]
        except Exception:
            pass
    # from pool_keywords choose words with reasonable edit distance & length
    pool = [p for p in pool_keywords if p.lower() != correct_word.lower() and len(p) > 3]
    # sort by not-too-close, prefer different first letter and different stem
    chosen = []
    for p in pool:
        if len(chosen) >= k:
            break
        # avoid near duplicates like 'packet' vs 'packets'
        if _simple_singular(p.lower()) == _simple_singular(correct_word.lower()):
            continue
        # avoid very similar strings
        if sum(1 for a,b in zip(p.lower(), correct_word.lower()) if a==b) / max(1, min(len(p), len(correct_word))) > 0.8:
            continue
        if p not in chosen:
            chosen.append(p)
    # pad with common technical words if needed
    fallback_pool = ["signal","device","network","method","structure","system","process","model","data","protocol"]
    i = 0
    while len(chosen) < k and i < len(fallback_pool):
        if fallback_pool[i] not in chosen and fallback_pool[i].lower() != correct_word.lower():
            chosen.append(fallback_pool[i])
        i += 1
    return chosen[:k]

# ---------------- generate question from chunk ----------------
def build_question_from_chunk(chunk, pool_keywords, difficulty="medium"):
    if HAVE_NLTK:
        try:
            sents = nltk.sent_tokenize(chunk)
        except Exception:
            sents = simple_sent_tokenize(chunk)
    else:
        sents = simple_sent_tokenize(chunk)

    candidates = [s for s in sents if len(simple_word_tokenize(s)) >= 6 and not looks_like_header_token(s)]
    random.shuffle(candidates)

    for s in candidates:
        # remove stray bullets/emojis from sentence
        s_clean = strip_noise = s
        s_clean = re.sub(r'^[\-\u2022\u25CF\u25CB\u25A0\u25B2\u2023\u2043\•\·\s]+', '', s_clean).strip()
        # avoid sentences starting with isolated uppercase tokens like "Textbook: Ch"
        # split on '•' or ':' to ignore leading short headers
        if '•' in s_clean or ':' in s_clean or '—' in s_clean:
            # prefer part after first delimiter if it is longer
            parts = re.split(r'[•:—\-–]', s_clean)
            # pick the longest part (likely the main clause)
            parts_sorted = sorted(parts, key=lambda x: len(x))
            if parts_sorted:
                s_clean = parts_sorted[-1].strip()

        # skip if pronoun-only or referential ambiguous ("It uses ...")
        if re.match(r'^(it|this|that|they|these|those)\b', s_clean.strip(), flags=re.I):
            continue

        # extract candidate keywords for the sentence
        keywords = extract_keywords_for_chunk(s_clean, topn=6)
        # fallback pick long words not stopwords
        if not keywords:
            words = simple_word_tokenize(s_clean)
            words = [w for w in words if w not in STOPWORDS and len(w) > 4]
            if words:
                keywords = [max(words, key=len)]

        for kw in keywords:
            # ensure keyword is present as a whole word
            if not re.search(r'\b' + re.escape(kw) + r'\b', s_clean, flags=re.I):
                continue
            # avoid numbers or weird tokens
            if re.search(r'\d', kw):
                continue
            # avoid when answer is already adjacent to punctuation giving away the answer
            # e.g., "Application Layer •" or headings
            # if keyword occurs in the very first 4 tokens and there's punctuation next, prefer different sentence
            tokpos = [i for i,t in enumerate(re.findall(r'\b\w+\b', s_clean)) if t.lower() == kw.lower()]
            if tokpos and tokpos[0] < 4:
                # check if sentence includes punctuation right after keyword or is header-like
                # prefer to reframe: take clause after ':' or '•' processed earlier
                pass

            # form cloze: replace the whole word case-insensitively
            pattern = re.compile(r'\b' + re.escape(kw) + r'\b', flags=re.IGNORECASE)
            qtext = pattern.sub('______', s_clean, count=1)

            # post-check: remove any stray emoji or bullets in qtext
            qtext = strip_noise_chars(qtext)
            if len(simple_word_tokenize(qtext)) < 4:
                continue

            # avoid when the answer still appears in the qtext due to capitalization variation
            if re.search(r'\b' + re.escape(kw) + r'\b', qtext, flags=re.IGNORECASE):
                continue

            # create distractors
            distractors = get_distractors(kw, pool_keywords, k=3)
            options = [kw] + distractors
            # ensure 4 options and uniqueness
            opts = []
            for o in options:
                o_clean = o.strip()
                if not o_clean:
                    continue
                if o_clean.lower() == kw.lower():
                    opts.insert(0, o_clean)
                else:
                    if o_clean not in opts:
                        opts.append(o_clean)
            # pad with pool_keywords if needed
            for g in pool_keywords:
                if len(opts) >= 4:
                    break
                if g.lower() != kw.lower() and g not in opts and len(g) > 2:
                    opts.append(g)
            # final fallback fill
            fallback_fill = ["Option A", "Option B", "Option C", "Option D"]
            i = 0
            while len(opts) < 4 and i < len(fallback_fill):
                if fallback_fill[i] not in opts:
                    opts.append(fallback_fill[i])
                i += 1

            # shuffle options but keep answer present
            random.shuffle(opts)
            # ensure answer exists (match case-insensitive) — pick canonical answer as kw
            return {
                "question": qtext,
                "options": opts,
                "answer": kw,
                "difficulty": difficulty,
                "category": "General"
            }

    return None

# ---------------- main API ----------------
def build_quiz_from_text(raw_text: str, num_questions: int = 15, difficulty: str = "medium", category: str = None):
    # 1) Clean document and remove headers/footers using segmentation
    merged = clean_and_merge_pages(raw_text)
    if not merged or len(merged) < 40:
        # fallback: simple sentence-based generator
        sentences = [s.strip() for s in re.split(r'[.?!]\s', raw_text) if len(s.strip()) > 20]
        quiz = []
        for i, s in enumerate(sentences[:num_questions]):
            quiz.append({
                "question": f"Q{i+1}: {s[:80]}... ?",
                "options": ["Option A", "Option B", "Option C", "Correct Answer"],
                "answer": "Correct Answer",
                "difficulty": difficulty,
                "category": "General"
            })
        return {"quiz": quiz}

    # 2) chunk & rank
    chunks = chunk_text(merged, chunk_size_words=280)
    if not chunks:
        # fallback again
        sentences = [s.strip() for s in re.split(r'[.?!]\s', merged) if len(s.strip()) > 20]
        quiz = []
        for i, s in enumerate(sentences[:num_questions]):
            quiz.append({
                "question": f"Q{i+1}: {s[:80]}... ?",
                "options": ["Option A", "Option B", "Option C", "Correct Answer"],
                "answer": "Correct Answer",
                "difficulty": difficulty,
                "category": "General"
            })
        return {"quiz": quiz}

    ranked = rank_chunks(chunks)

    # 3) global keyword pool (top-ranked chunks)
    pool_keywords = []
    for chunk in ranked[:min(12, len(ranked))]:
        pool_keywords.extend(extract_keywords_for_chunk(chunk, topn=12))
    # dedupe while preserving order
    seen = set()
    pool_keywords = [k for k in pool_keywords if k and (k.lower() not in seen and not seen.add(k.lower()))]

    # 4) pick chunk indices spread across doc to ensure coverage
    n_chunks = len(ranked)
    # choose indices evenly spaced and jittered
    indices = []
    for i in range(min(num_questions, n_chunks)):
        idx = int((i * n_chunks) / max(1, min(num_questions, n_chunks)))
        idx = min(n_chunks - 1, max(0, idx + (i % 3) - 1))
        indices.append(idx)
    indices = list(dict.fromkeys(indices))  # unique

    quiz = []
    # 5) generate questions from selected chunks
    for idx in indices:
        chunk = ranked[idx]
        q = build_question_from_chunk(chunk, pool_keywords, difficulty=difficulty)
        if q:
            if category:
                q["category"] = category
            quiz.append(q)
        if len(quiz) >= num_questions:
            break

    # 6) if still short, attempt remaining chunks
    if len(quiz) < num_questions:
        for chunk in ranked:
            q = build_question_from_chunk(chunk, pool_keywords, difficulty=difficulty)
            if q:
                if category:
                    q["category"] = category
                # avoid duplicates by answer+question text
                if all(not (q["question"] == existing["question"] or q["answer"].lower() == existing["answer"].lower()) for existing in quiz):
                    quiz.append(q)
            if len(quiz) >= num_questions:
                break

    # 7) final fallback ensure we return as many as requested
    if len(quiz) < num_questions:
        sentences = [s.strip() for s in re.split(r'[.?!]\s', merged) if len(s.strip()) > 20]
        for s in sentences:
            if len(quiz) >= num_questions:
                break
            quiz.append({
                "question": f"{s[:80]}... ?",
                "options": ["Option A", "Option B", "Option C", "Correct Answer"],
                "answer": "Correct Answer",
                "difficulty": difficulty,
                "category": "General"
            })

    return {"quiz": quiz[:num_questions]}

# compatibility: if user passes a pdf path
def build_quiz(pdf_name: str, num_questions: int = 15, difficulty: str = "medium", category: str = None):
    if fitz is None:
        raise RuntimeError("PyMuPDF is not installed.")
    pages = []
    with fitz.open(pdf_name) as doc:
        for page in doc:
            pages.append(page.get_text())
    merged = "\f".join(pages)
    return build_quiz_from_text(merged, num_questions=num_questions, difficulty=difficulty, category=category)
