function goHome() {
  window.location.href = "index.html";
}
function goProg() {
  window.location.href = "progress.html";
}
function logout() {
  localStorage.removeItem('user');
  sessionStorage.removeItem('user');
  window.location.href = "home.html";
}

const quizTypeSelection = document.getElementById("quiz-type-selection");
const normalQuizSetup = document.getElementById("normal-quiz-setup");
const pdfQuizSetup = document.getElementById("pdf-quiz-setup");
const normalQuizBtn = document.getElementById("normalQuizBtn");
const pdfQuizBtn = document.getElementById("pdfQuizBtn");
const backToTypeSelect1 = document.getElementById("backToTypeSelect1");
const backToTypeSelect2 = document.getElementById("backToTypeSelect2");
const startNormalQuizBtn = document.getElementById("startNormalQuizBtn");
const startPdfQuizBtn = document.getElementById("startPdfQuizBtn");

const categorySelect = document.getElementById("categorySelect");
const difficultySelect = document.getElementById("difficultySelect");
const amountSelect = document.getElementById("amountSelect");
const timerSelect = document.getElementById("timerSelect");
const adaptiveToggle = document.getElementById("adaptiveToggle");

const customTopicInput = document.getElementById("customTopicInput");

const pdfInput = document.getElementById("pdfInput");
const pdfDifficultySelect = document.getElementById("pdfDifficultySelect");
const pdfAmountSelect = document.getElementById("pdfAmountSelect");
const pdfPreview = document.getElementById("pdfPreview");
const pdfTopicRename = document.querySelector(".pdf-topic-rename");
const pdfTopicName = document.getElementById("pdfTopicName");
const generateOfflinePdfBtn = document.getElementById("generateOfflinePdfBtn");
const takeOfflineQuizBtn = document.getElementById("takeOfflineQuizBtn");

const quizSection = document.querySelector(".quiz-section");
const questionEl = document.getElementById("question");
const optionsEl = document.querySelector(".options");
const nextBtn = document.getElementById("next");
const explainBtn = document.getElementById("explain");
const explanationEl = document.getElementById("explanation");
const resultEl = document.getElementById("result");
const timerEl = document.getElementById("timer");
const progressEl = document.querySelector(".progress");
const questionCounter = document.getElementById("questionCounter");
const correctSound = document.getElementById("correctSound");
const wrongSound = document.getElementById("wrongSound");
const restartBtn = document.getElementById("restartQuiz");
const goToProgressBtn = document.getElementById("goToProgressBtn");

const performanceDashboard = document.getElementById("performanceDashboard");
const accuracyStat = document.getElementById("accuracyStat");
const avgTimeStat = document.getElementById("avgTimeStat");
const badgesEarned = document.getElementById("badgesEarned");

let quizToken = null;
let questions = [];
let currentIndex = 0;
let score = 0;
let timer = null;
let currentCorrectAnswer = "";
let quizType = null;
let totalTimeTaken = 0;
let timerStart = null;
// Track which PDF document (IndexedDB) is currently being played, if any
let currentDocId = null;
// Track the uploaded PDF filename when user uploads a PDF (used to derive quiz name)
let currentUploadedPdfName = null;

// Backend root (useful when serving the static site from a different host during dev)
const BACKEND_URL = window.BACKEND_URL || 'http://127.0.0.1:5000';

// Configure PDF.js worker to avoid deprecated API warning and worker load attempts
try {
  if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.8.162/pdf.worker.min.js';
  }
} catch (e) { /* ignore if pdfjsLib not present */ }

// ---------------- Firestore integration helpers ----------------
function formatYMD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function writeQuizAttemptToFirestore(quizRecord, pdfName) {
  if (!window.db || !window.auth || !window.auth.currentUser) return false;
  try {
    const uid = window.auth.currentUser.uid;
    const progressRef = window.db.collection('users').doc(uid).collection('progress');
    const doc = {
      type: 'quiz_attempt',
      quizName: quizRecord.quizName || quizRecord.topic || ('Quiz ' + (quizRecord.date || new Date().toISOString())),
      topic: quizRecord.topic || pdfName || '',
      score: Number(quizRecord.score || 0),
      date: quizRecord.date || formatYMD(new Date()),
      created_at: (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue) ? window.firebase.firestore.FieldValue.serverTimestamp() : new Date(),
      pdfName: pdfName || quizRecord.topic || quizRecord.quizName
    };
    await progressRef.add(doc);
    // try to update streak_meta (best-effort) by calling central helper if present
    try {
      if (window.progressTracker && typeof window.progressTracker.recordQuizAttempt === 'function') {
        // Let the central helper handle streaks; it already pushed into quizzes array.
        // We only call it here if it's not already being used by caller.
      }
      // If no central helper is available, try to touch streak_meta directly
      try {
        if (window.db) {
          const metaRef = window.db.collection('users').doc(uid).collection('progress').doc('streak_meta');
          const today = formatYMD(new Date());
          const snap = await metaRef.get();
          if (!snap.exists) {
            await metaRef.set({ streak_count: 1, last_login: today, updated_at: (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue) ? window.firebase.firestore.FieldValue.serverTimestamp() : new Date() });
          } else {
            const meta = snap.data() || {};
            const last = meta.last_login || '';
            if (last !== today) {
              const newCount = (Number(meta.streak_count) || 0) + 1;
              await metaRef.update({ streak_count: newCount, last_login: today, updated_at: (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue) ? window.firebase.firestore.FieldValue.serverTimestamp() : new Date() });
            } else {
              await metaRef.update({ updated_at: (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue) ? window.firebase.firestore.FieldValue.serverTimestamp() : new Date() });
            }
          }
        }
      } catch (e) { /* non-fatal */ }
    } catch (ee) { /* ignore */ }
    return true;
  } catch (e) {
    console.warn('Failed to write quiz attempt to Firestore', e);
    return false;
  }
}

// Update streak on auth change (best-effort)
if (window.auth) {
  window.auth.onAuthStateChanged(async (user) => {
    if (!user || !window.db) return;
    try {
      const uid = user.uid;
      const progressRef = window.db.collection('users').doc(uid).collection('progress');
      const metaRef = progressRef.doc('streak_meta');
      const metaSnap = await metaRef.get();
      const meta = metaSnap.exists ? metaSnap.data() : {};
      const today = formatYMD(new Date());
      const yesterday = formatYMD(new Date(Date.now() - 24 * 3600 * 1000));
      let streak = meta.streak_count || 0;
      const last = meta.last_login || null;
      if (last === today) {
        // already recorded
      } else if (last === yesterday) {
        streak = (streak || 0) + 1;
      } else {
        streak = 1;
      }
      await metaRef.set({ last_login: today, streak_count: streak }, { merge: true });
    } catch (err) {
      console.warn('Failed to update streak on auth change', err);
    }
  });
}


// Load categories with "Others" option
async function loadCategories() {
  try {
    const res = await fetch('https://opentdb.com/api_category.php');
    const data = await res.json();
    (data.trivia_categories || []).forEach(cat => {
      const opt = document.createElement("option");
      opt.value = cat.id;
      opt.textContent = cat.name;
      categorySelect.appendChild(opt);
    });
  } catch (e) {
    console.warn('Could not load remote categories (offline?):', e);
    // fall through to provide at least no-network option
  }
  // Always ensure 'Others' option exists so user can still create topic quizzes offline
  const othersOpt = document.createElement("option");
  othersOpt.value = "-1";
  othersOpt.textContent = "Others (Custom Topic)";
  categorySelect.appendChild(othersOpt);
}

categorySelect.addEventListener("change", () => {
  if (categorySelect.value === "-1") {
    customTopicInput.classList.remove("hidden");
  } else {
    customTopicInput.classList.add("hidden");
    customTopicInput.value = "";
  }
});


async function getToken() {
  const res = await fetch('https://opentdb.com/api_token.php?command=request');
  const data = await res.json();
  quizToken = data.token;
}

normalQuizBtn.onclick = () => {
  quizType = "normal";
  quizTypeSelection.classList.add("hidden");
  normalQuizSetup.classList.remove("hidden");
};

pdfQuizBtn.onclick = () => {
  quizType = "pdf";
  quizTypeSelection.classList.add("hidden");
  pdfQuizSetup.classList.remove("hidden");
  pdfTopicRename.classList.add("hidden");
  pdfTopicName.value = "";
};

backToTypeSelect1.onclick = () => {
  normalQuizSetup.classList.add("hidden");
  quizTypeSelection.classList.remove("hidden");
  customTopicInput.classList.add("hidden");
};

backToTypeSelect2.onclick = () => {
  pdfQuizSetup.classList.add("hidden");
  quizTypeSelection.classList.remove("hidden");
  pdfPreview.src = "";
  pdfPreview.classList.add("hidden");
  startPdfQuizBtn.disabled = true;
};

pdfInput.addEventListener("change", () => {
  if (pdfInput.files.length === 0) {
    startPdfQuizBtn.disabled = true;
    pdfPreview.src = "";
    pdfPreview.classList.add("hidden");
    pdfTopicRename.classList.add("hidden");
    return;
  }
  startPdfQuizBtn.disabled = false;
  if (generateOfflinePdfBtn) generateOfflinePdfBtn.disabled = false;
  const fileURL = URL.createObjectURL(pdfInput.files[0]);
  pdfPreview.src = fileURL;
  pdfPreview.classList.remove("hidden");

  // Show the rename input so the user can edit the PDF-derived topic name
  pdfTopicRename.classList.remove("hidden");
  const fileName = pdfInput.files[0].name.replace(/\.[^/.]+$/, "");
  pdfTopicName.value = fileName;
  // remember uploaded filename for later use when saving quiz/result
  currentUploadedPdfName = pdfInput.files[0].name;
});

startNormalQuizBtn.onclick = async () => {
  if (!quizToken) await getToken();

  if (categorySelect.value === "-1") {
    const topic = customTopicInput.value.trim();
    if (!topic) {
      alert("Please enter a custom topic.");
      return;
    }
  questions = await generateQuizForTopic(topic, parseInt(amountSelect.value), difficultySelect.value, /*isTopic=*/ true);
    document.getElementById("quiz-title").textContent = `Custom Quiz: ${topic}`;
    startQuiz();
    return;
  }

  const category = categorySelect.value;
  const difficulty = difficultySelect.value;
  const amount = amountSelect.value;
  const categoryName = categorySelect.options[categorySelect.selectedIndex].text;
  document.getElementById("quiz-title").textContent = `${categoryName} Quiz`;

  let apiUrl = `https://opentdb.com/api.php?amount=${amount}&token=${quizToken}&type=multiple`;
  if (category) apiUrl += `&category=${category}`;
  if (difficulty) apiUrl += `&difficulty=${difficulty}`;

  const res = await fetch(apiUrl);
  const data = await res.json();

  if (data.response_code === 4) {
    await fetch(`https://opentdb.com/api_token.php?command=reset&token=${quizToken}`);
    return startNormalQuizBtn.click();
  }
  questions = data.results;
  startQuiz();
}

async function generateQuizForTopic(topic, amount, difficulty, isTopic=false) {
  // Build topic keywords to validate returned questions more robustly.
  // Split on non-word characters so multi-word topics like "data structures" produce keywords ["data","structures"].
  const topicStr = (topic || '').trim();
  const topicKeywords = topicStr.length ? topicStr.split(/\W+/).filter(Boolean).map(s => s.toLowerCase()) : [];

  // Validator: server result must be an array and each returned item should mention at least one topic keyword
  // in either the question text, any option, or the answer. Also require at least `amount` items.
  const validator = (res, data) => {
    if (!data || !Array.isArray(data.quiz)) return false;
    const quiz = data.quiz;
    if (quiz.length < amount) return false; // require full amount
    if (!topicKeywords.length) return true; // no specific topic provided
    for (const it of quiz) {
      const q = (it.question || '').toString().toLowerCase();
      const a = (it.answer || '').toString().toLowerCase();
      // require at least one keyword to appear either in the question text OR in the answer
      const ok = topicKeywords.some(k => (q.includes(k) || a.includes(k)) );
      if (!ok) return false;
    }
    return true;
  };

  if (navigator.onLine) {
    try {
      // Try up to 5 attempts with exponential backoff using our helper
      const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: topicStr, amount: amount, difficulty: difficulty, is_topic: !!isTopic })
      };
      try {
  const { res, data } = await fetchWithRetries(`${BACKEND_URL}/generate-quiz`, options, 5, 1500, validator);
        if (data && Array.isArray(data.quiz) && data.quiz.length > 0) {
          return data.quiz.map((it) => {
            if (it.question && it.options && it.answer) {
              return {
                question: it.question,
                correct_answer: it.answer,
                incorrect_answers: it.options.filter(o => o !== it.answer)
              };
            }
            return it;
          });
        }
      } catch (e) {
        console.warn('Server topic-generation failed after retries, falling back to client topic-generator', e);
      }
    } catch (err) {
      console.warn('Server quiz generation failed, falling back to client topic-generator', err);
    }
  }

  // Fallback: strong client-side topic generator that embeds the topic word in each question
  const generated = [];
  const base = topicStr ? `About ${topicStr}:` : 'Topic:';
  for (let i = 1; i <= amount; i++) {
    const qText = `${base} Which statement correctly describes ${topicStr}? (Item ${i})`;
    generated.push({
      question: qText,
      correct_answer: `${topicStr} (correct statement ${i})`,
      incorrect_answers: [`Not ${topicStr} A`, `Not ${topicStr} B`, `Not ${topicStr} C`]
    });
  }
  return generated;
}

startPdfQuizBtn.onclick = async () => {
  if (pdfInput.files.length === 0) {
    alert("Please upload a PDF file first.");
    return;
  }
  const difficulty = pdfDifficultySelect.value;
  const amount = parseInt(pdfAmountSelect.value);
  const topicName = pdfTopicName.value.trim() || "PDF Quiz";

  document.getElementById("quiz-title").textContent = topicName;

  const file = pdfInput.files[0];
  const fileReader = new FileReader();

  fileReader.onload = function () {
    const typedarray = new Uint8Array(this.result);
    // Try normal worker-based loading first. If the worker cannot be loaded (e.g. offline CDN),
    // fall back to a main-thread parse by retrying with `disableWorker: true`.
  // Default to disableWorker:true to avoid pdf.js attempting to fetch the worker script
  // from a CDN when offline. This uses the main thread for parsing (slower), but
  // prevents 'Setting up fake worker failed' errors when offline.
  const doLoadWithOptions = (opts) => pdfjsLib.getDocument(Object.assign({ data: typedarray, disableWorker: true }, opts));

    let loadingTask = doLoadWithOptions();
    const tryDisableWorkerFallback = async (reason) => {
      console.warn('PDF worker failed to load, retrying with disableWorker:true', reason);
      try {
        loadingTask = doLoadWithOptions({ disableWorker: true });
        const pdf = await loadingTask.promise;
        return pdf;
      } catch (e) {
        throw e;
      }
    };

    loadingTask.promise.then(async function (pdf) {
      let fullText = "";
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        const strings = content.items.map(item => item.str);
        fullText += strings.join(" ") + " ";
      }
      // Prefer server-side Gemini generation when online. Server uses GEMINI_API_KEY from .env.
      let questionsFromServer = null;
      if (navigator.onLine) {
        try {
          generateOfflinePdfBtn && (generateOfflinePdfBtn.disabled = true);
          showToast('Generating quiz via server (using server GEMINI key)...');
          const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: fullText, amount: amount, difficulty: difficulty })
          };
          const validator = (res, data) => {
            if (!data) return false;
            if (!Array.isArray(data.quiz)) return false;
            return data.quiz.length >= Math.max(1, Math.floor(amount * 0.5));
          };
          try {
            const { res, data } = await fetchWithRetries(`${BACKEND_URL}/generate-quiz`, options, 5, 1500, validator);
            if (data && Array.isArray(data.quiz) && data.quiz.length > 0) {
              questionsFromServer = data.quiz.map(it => {
                if (it.question && it.options && it.answer) {
                  return { question: it.question, correct_answer: it.answer, incorrect_answers: it.options.filter(o=>o!==it.answer) };
                }
                return it;
              });
            }
          } catch (e) {
            console.warn('Server generation failed after retries, falling back to client generator', e);
          }
        } finally {
          generateOfflinePdfBtn && (generateOfflinePdfBtn.disabled = false);
        }
      }

      if (questionsFromServer) {
        // Use server-generated quiz immediately when online. Do NOT auto-save to local
        // storage here — saving for offline should only happen when the user explicitly
        // requests it via the "Generate Offline" button.
        questions = questionsFromServer;
        startQuiz();
        return;
      }

      // Fallback to client generator if server didn't provide a quiz
      questions = await questionGenerator(fullText, difficulty, amount);
      if (!questions || questions.length === 0) {
        alert("No questions could be generated from the PDF.");
        return;
      }
      startQuiz();
    }).catch(async (reason) => {
      // Detect worker load failure and attempt a main-thread fallback
      const msg = (reason && reason.message) ? reason.message : String(reason);
      if (msg.includes('Setting up fake worker failed') || msg.includes('Cannot load script') || msg.includes('worker')) {
        try {
          const pdf = await tryDisableWorkerFallback(reason);
          // proceed as above
          let fullText = "";
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const content = await page.getTextContent();
            const strings = content.items.map(item => item.str);
            fullText += strings.join(" ") + " ";
          }
          // Try server generation first (same as above)
          let questionsFromServer2 = null;
          if (navigator.onLine) {
            try {
              showToast('Generating quiz via server (using server GEMINI key)...');
              const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: fullText, amount: amount, difficulty: difficulty })
              };
              const validator = (res, data) => {
                if (!data) return false;
                if (!Array.isArray(data.quiz)) return false;
                return data.quiz.length >= Math.max(1, Math.floor(amount * 0.5));
              };
              try {
                const { res, data } = await fetchWithRetries(`${BACKEND_URL}/generate-quiz`, options, 5, 1500, validator);
                if (data && Array.isArray(data.quiz) && data.quiz.length > 0) {
                  questionsFromServer2 = data.quiz.map(it => {
                    if (it.question && it.options && it.answer) {
                      return { question: it.question, correct_answer: it.answer, incorrect_answers: it.options.filter(o=>o!==it.answer) };
                    }
                    return it;
                  });
                }
              } catch (e) {
                console.warn('Server generation failed after retries, falling back to client generator', e);
              }
            } finally {}
          }

          if (questionsFromServer2) {
            // Use server-generated quiz immediately but do not persist it automatically.
            questions = questionsFromServer2;
            startQuiz();
            return;
          }

          questions = await questionGenerator(fullText, difficulty, amount);
          if (!questions || questions.length === 0) {
            alert("No questions could be generated from the PDF.");
            return;
          }
          startQuiz();
          return;
        } catch (e) {
          console.error('Fallback PDF parse failed', e);
          alert('Error loading PDF (worker and main-thread fallback both failed): ' + e);
          return;
        }
      }
      console.error('Error loading PDF:', reason);
      alert("Error loading PDF: " + reason);
    });
  };

  fileReader.readAsArrayBuffer(file);
}

async function questionGenerator(text, difficulty, amount) {
  // Prefer server-side generation when online; server will use GEMINI API if configured
  if (navigator.onLine) {
    try {
      const res = await fetch(`${BACKEND_URL}/generate-quiz`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, amount: amount, difficulty: difficulty })
      });
        if (res.ok) {
          const data = await res.json();
          const quiz = data.quiz || [];
          return quiz.map((it) => {
            if (it.question && it.options && it.answer) {
              return {
                question: it.question,
                correct_answer: it.answer,
                incorrect_answers: it.options.filter(o => o !== it.answer)
              };
            }
            return it;
          });
        }
    } catch (err) {
      console.warn('Server PDF quiz generation failed, falling back to client parser', err);
    }
  }

  // Fallback local extraction when server not reachable
  const sentences = text.split(/[.?!]\s/).filter(s => s.length > 20);
  const generated = sentences.slice(0, amount).map((sentence, index) => ({
    question: `What is the topic of sentence ${index + 1}?`,
    correct_answer: sentence,
    incorrect_answers: ["Option 1", "Option 2", "Option 3"],
  }));
  return generated;
}

/* IndexedDB helpers for storing locally-generated PDF quizzes */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('quiz-db-v1', 1);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('documents')) {
        db.createObjectStore('documents', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function saveDocument(doc) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDb();
      const tx = db.transaction('documents', 'readwrite');
      const store = tx.objectStore('documents');
      if (!doc.id) doc.id = 'doc-' + Date.now();
      store.put(doc);
      tx.oncomplete = () => resolve(doc.id);
      tx.onerror = () => reject(tx.error);
    } catch (e) { reject(e); }
  });
}

function getDocument(id) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDb();
      const tx = db.transaction('documents', 'readonly');
      const store = tx.objectStore('documents');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

function deleteDocument(id) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDb();
      const tx = db.transaction('documents', 'readwrite');
      const store = tx.objectStore('documents');
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

function listDocuments() {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDb();
      const tx = db.transaction('documents', 'readonly');
      const store = tx.objectStore('documents');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

async function renderLocalQuizList() {
  const list = document.getElementById('localQuizList');
  if (!list) return;
  list.innerHTML = '';
  try {
    const docs = await listDocuments();
    if (!docs || docs.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No offline quizzes saved yet.';
      list.appendChild(li);
      return;
    }
    docs.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
    docs.forEach(doc => {
      const li = document.createElement('li');
      li.className = 'local-quiz-item';

      const left = document.createElement('div');
      left.className = 'local-quiz-left';

      const title = document.createElement('div');
      title.className = 'local-quiz-title';
      title.textContent = doc.name || doc.id || 'Untitled Quiz';

      const meta = document.createElement('div');
      meta.className = 'local-quiz-meta';
      meta.textContent = `${doc.pdfName ? doc.pdfName + ' • ' : ''}${doc.createdAt ? new Date(doc.createdAt).toLocaleString() : ''}`;

      left.appendChild(title);
      left.appendChild(meta);

      const controls = document.createElement('div');
      controls.className = 'local-quiz-controls';

      const btnStart = document.createElement('button');
      btnStart.className = 'start-btn';
      btnStart.textContent = 'Start';
      btnStart.onclick = () => startLocalQuiz(doc.id);

      const btnDelete = document.createElement('button');
      btnDelete.className = 'delete-btn';
      btnDelete.textContent = 'Delete';
      btnDelete.onclick = async () => { await deleteDocument(doc.id); await renderLocalQuizList(); };

      controls.appendChild(btnStart);
      controls.appendChild(btnDelete);

      li.appendChild(left);
      li.appendChild(controls);
      list.appendChild(li);
    });
  } catch (e) {
    console.error('renderLocalQuizList error', e);
    const li = document.createElement('li');
    li.textContent = 'Failed to load local quizzes.';
    list.appendChild(li);
  }
}

async function startLocalQuiz(id) {
  try {
    const doc = await getDocument(id);
    if (!doc || !doc.generatedQuiz) { alert('Quiz not found or invalid.'); return; }
    questions = doc.generatedQuiz;
    quizType = 'pdf';
    document.getElementById('quiz-title').textContent = doc.name || 'Offline Quiz';
    // remember which document is playing so we can update its score later
    currentDocId = id;
    startQuiz();
  } catch (e) {
    console.error('startLocalQuiz error', e);
    alert('Failed to start quiz.');
  }
}

function localQuestionGenerator(text, amount) {
  const sentences = text.split(/[.?!]\s/).filter(s => s.trim().length > 20);
  const pool = sentences.length ? sentences : [text.slice(0,200)];
  const generated = [];
  for (let i=0;i<amount;i++) {
    const s = pool[i % pool.length];
    generated.push({
      question: `Based on the PDF: choose the best summary for item ${i+1}`,
      correct_answer: s.trim(),
      incorrect_answers: ['Distractor A','Distractor B','Distractor C']
    });
  }
  return generated;
}

function showToast(msg) {
  // minimal toast: alert fallback
  try {
    // if a nicer toast exists, use it — otherwise use alert
    if (window.toastr) { window.toastr.success(msg); return; }
  } catch(e) {}
  console.log(msg);
}

/**
 * Fetch with retries and exponential backoff.
 * - url: fetch url
 * - options: fetch options
 * - attempts: max attempts
 * - baseDelay: initial delay in ms
 * - validator: function(response, data) => boolean to decide if response is acceptable
 */
async function fetchWithRetries(url, options, attempts = 5, baseDelay = 1500, validator = null) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        // if 4xx (client error), probably won't succeed on retry; break for efficiency
        if (res.status >= 400 && res.status < 500) {
          // but still attempt to parse body for more info
          try { const txt = await res.text(); console.warn('Client error body:', txt); } catch(e){}
          throw lastErr;
        }
      }
      // try to parse json (may throw)
      const data = await res.json().catch(e => { lastErr = e; return null; });
      if (validator) {
        try {
          const ok = await validator(res, data);
          if (ok) return { res, data };
          lastErr = new Error('Validator rejected response');
        } catch (e) { lastErr = e; }
      } else {
        return { res, data };
      }
    } catch (e) {
      lastErr = e;
      console.warn(`Attempt ${i} failed:`, e);
    }
    if (i < attempts) {
      const delay = baseDelay * Math.pow(2, i-1);
      showToast(`Attempt ${i + 1} of ${attempts} in ${Math.round(delay/1000)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}


function startQuiz() {
  currentIndex = 0;
  score = 0;
  totalTimeTaken = 0;
  document.querySelectorAll(".quiz-setup").forEach(el => el.classList.add("hidden"));
  quizSection.classList.remove("hidden");
  performanceDashboard.classList.add("hidden");
  goToProgressBtn.classList.add("hidden");
  showQuestion();
}

function decodeHTML(html) {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

function showQuestion() {
  if (currentIndex >= questions.length) {
    showResult();
    return;
  }
  const q = questions[currentIndex];
  questionEl.textContent = decodeHTML(q.question || "");
  optionsEl.innerHTML = "";
  explanationEl.classList.add("hidden");
  explainBtn.classList.add("hidden");
  nextBtn.disabled = true;
  resultEl.classList.add("hidden");

  const opts = (q.incorrect_answers && q.correct_answer)
    ? [...q.incorrect_answers, q.correct_answer]
    : (q.options || []);

  const options = opts.map(decodeHTML).sort(() => Math.random() - 0.5);
  currentCorrectAnswer = decodeHTML(q.correct_answer || q.answer || "");

  options.forEach(option => {
    const btn = document.createElement("button");
    btn.textContent = option;
    btn.onclick = () => selectAnswer(btn);
    optionsEl.appendChild(btn);
  });

  questionCounter.textContent = `Question ${currentIndex + 1} of ${questions.length}`;
  const selectedTime = parseInt(timerSelect.value);
  startTimer(selectedTime);
  updateProgress();
  timerStart = Date.now();
}

function selectAnswer(btn) {
  const userAnswer = btn.textContent;
  const allButtons = optionsEl.querySelectorAll("button");
  allButtons.forEach(b => {
    b.disabled = true;
    if (b.textContent === currentCorrectAnswer) {
      b.classList.add("correct");
    }
    if (b === btn && userAnswer !== currentCorrectAnswer) {
      b.classList.add("wrong");
    }
  });

  const timeTaken = Math.floor((Date.now() - timerStart) / 1000);
  totalTimeTaken += timeTaken;

  if (userAnswer === currentCorrectAnswer) {
    score++;
    correctSound.play();
  } else {
    wrongSound.play();
    if (adaptiveToggle && adaptiveToggle.checked && difficultySelect.value !== "easy") {
      const currentDifficulty = difficultySelect.value;
      if (currentDifficulty === "hard") difficultySelect.value = "medium";
      else if (currentDifficulty === "medium") difficultySelect.value = "easy";
    }
  }
  explainBtn.classList.remove("hidden");
  nextBtn.disabled = false;
  clearInterval(timer);
}

function startTimer(seconds) {
  let time = seconds;
  timerEl.textContent = time;
  clearInterval(timer);

  if (seconds === 0) {
    timerEl.textContent = "∞";
    return;
  }

  timer = setInterval(() => {
    time--;
    timerEl.textContent = time;
    if (time <= 0) {
      clearInterval(timer);
      nextQuestion();
    }
  }, 1000);
}

function updateProgress() {
  const progress = ((currentIndex + 1) / questions.length) * 100;
  progressEl.style.width = `${progress}%`;

  if (progress < 30) {
    questionCounter.textContent += " • Keep going!";
  } else if (progress < 70) {
    questionCounter.textContent += " • You're doing great!";
  } else {
    questionCounter.textContent += " • Almost there!";
  }
}

nextBtn.addEventListener("click", nextQuestion);

function nextQuestion() {
  currentIndex++;
  if (currentIndex < questions.length) {
    showQuestion();
  } else {
    showResult();
  }
}

explainBtn.addEventListener("click", async () => {
  // Call backend explanation endpoint when possible
  const q = questions[currentIndex];
  const questionText = q.question || q.question_text || "";
  const correct = q.correct_answer || q.answer || q.correct || "";
  explanationEl.textContent = "Loading explanation...";
  explanationEl.classList.remove("hidden");
  if (navigator.onLine) {
    try {
      const res = await fetch(`${BACKEND_URL}/explain-answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: questionText, correct_answer: correct })
      });
      if (res.ok) {
        const data = await res.json();
        explanationEl.textContent = data.explanation || data.explain || "No explanation returned.";
        return;
      }
    } catch (err) {
      console.warn('Explain API failed, showing local message', err);
    }
  }
  explanationEl.textContent = "Explanation functionality not available (offline).";
});

async function showResult() {
  // Hide all quiz setup and quiz sections
  document.getElementById('quiz-type-selection').classList.add('hidden');
  document.getElementById('normal-quiz-setup').classList.add('hidden');
  document.getElementById('pdf-quiz-setup').classList.add('hidden');
  document.querySelector('.quiz-section').classList.add('hidden');

  // Show only the performance dashboard
  document.getElementById('performanceDashboard').classList.remove('hidden');

  // Change main heading to "Your Performance"
  document.getElementById('quiz-title').textContent = "Your Performance";

  // Your usual stats logic below
  const accuracy = Math.round((score / questions.length) * 100);
  const avgTime = Math.round(totalTimeTaken / questions.length);

  accuracyStat.textContent = `${accuracy}%`;
  avgTimeStat.textContent = `${avgTime}s`;

  let badge = "None";
  if (accuracy === 100) badge = "Perfect!";
  else if (accuracy >= 80) badge = "Gold";
  else if (accuracy >= 50) badge = "Silver";
  else badge = "Keep Practicing";
  badgesEarned.textContent = badge;
  // Record quiz result automatically in progress tracker only for PDF quizzes
  if (quizType === 'pdf') {
    try {
      const titleText = document.getElementById('quiz-title').textContent || '';
      const iso = new Date().toISOString();

      // Determine canonical quiz name and topic — prefer the saved document name, then the rename input, then uploaded filename, then titleText
      let quizName = null;
      let topic = null;
      let docUpdated = false;
      try {
        if (currentDocId) {
          const doc = await getDocument(currentDocId);
          if (doc) {
            quizName = doc.name || doc.pdfName || titleText;
            topic = quizName;
            // Update the saved document with the latest score and timestamp
            doc.lastScore = accuracy;
            doc.lastUpdated = iso;
            try { await saveDocument(doc); docUpdated = true; } catch(e){ console.warn('Failed to update saved doc with score', e); }
          }
        }
      } catch(e) { console.warn('Error fetching current doc', e); }

      // If we haven't updated a doc yet, try to find an existing saved doc by pdfName or quizName and update it
      if (!docUpdated) {
        try {
          const allDocs = await listDocuments();
          const match = allDocs.find(d => (d.pdfName && currentUploadedPdfName && d.pdfName === currentUploadedPdfName) || (d.name && (d.name === (pdfTopicName && pdfTopicName.value.trim() ? pdfTopicName.value.trim() : titleText))));
          if (match) {
            match.lastScore = accuracy;
            match.lastUpdated = iso;
            try { await saveDocument(match); currentDocId = match.id; docUpdated = true; } catch(e) { console.warn('Failed to update matched doc', e); }
          }
        } catch(e) { /* ignore */ }
      }

      if (!quizName) {
        if (pdfTopicName && pdfTopicName.value.trim()) {
          quizName = pdfTopicName.value.trim();
          topic = quizName;
        } else if (currentUploadedPdfName) {
          quizName = currentUploadedPdfName.replace(/\.[^/.]+$/, '');
          topic = quizName;
        } else {
          quizName = titleText || `PDF Quiz ${iso}`;
          topic = quizName;
        }
      }

      const quizRecord = { quizName, topic, score: accuracy, date: iso.slice(0,10) };
      // Debug: log runtime state so we can trace why saves fail
      try {
        console.debug('Saving PDF quiz result', { quizType, quizRecord, currentDocId, currentUploadedPdfName, windowAuth: !!(window.auth && window.auth.currentUser), hasProgressTracker: !!window.progressTracker });
      } catch(e){}

      // Immediately persist locally so progress page will always show the result
      try {
        const raw = localStorage.getItem('progressData');
        let payload = { subjects: [], quizzes: [] };
        if (raw) {
          try { payload = JSON.parse(raw); } catch(e) { payload = { subjects: [], quizzes: [] }; }
        }
        payload.quizzes = payload.quizzes || [];
        const found = payload.quizzes.findIndex(q => q.quizName === quizRecord.quizName);
        if (found >= 0) payload.quizzes[found] = quizRecord; else payload.quizzes.push(quizRecord);
        localStorage.setItem('progressData', JSON.stringify(payload));
        try { console.debug('Wrote progressData to localStorage', { key: 'progressData', size: (localStorage.getItem('progressData') || '').length }); } catch(e){}
      } catch (e) {
        console.warn('Could not write local progress before sync', e);
      }
      // Then attempt to sync to server (async)
          // Prefer the central progressTracker if available (handles Firestore + streaks)
          try {
            if (window.progressTracker && typeof window.progressTracker.recordQuizAttempt === 'function') {
              // Call the central tracker and await; if it fails, fall back to recordQuizResult
              try {
                await window.progressTracker.recordQuizAttempt(quizRecord);
              } catch (err) {
                console.warn('progressTracker.recordQuizAttempt failed, falling back to recordQuizResult', err);
                try { await recordQuizResult(quizRecord); } catch (e2) { console.warn('Fallback recordQuizResult also failed', e2); }
              }
            } else {
              await recordQuizResult(quizRecord);
            }
          } catch (e) {
            console.warn('Failed to record quiz result', e);
          }
    } catch (e) { console.warn('Failed to record quiz result', e); }
      // After attempting to record this quiz, also attempt a silent flush of any remaining local quizzes
      try {
        if (window.progressTracker && typeof window.progressTracker.flushLocalQuizzes === 'function') {
          // fire-and-forget; failures are logged by the helper
          window.progressTracker.flushLocalQuizzes().catch(err => console.warn('Auto-flush failed', err));
        }
      } catch (err) { console.warn('Auto-flush invocation failed', err); }
  }
}

// Persist quiz result to server or localStorage fallback (structure matches progress page)
async function recordQuizResult(quizRecord) {
  // Try to post to server via sync-progress endpoint which accepts full payload
  const trySync = async (payload) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/sync-progress`, {
        method: 'POST',
        credentials: 'include',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  };

  // Attempt to fetch existing local data and append
  try {
    // If server available and online, attempt a sync by fetching current progress then updating
    if (navigator.onLine) {
      try {
  const getRes = await fetch(`${BACKEND_URL}/api/user-progress`, {credentials: 'include'});
        if (getRes.ok) {
          const data = await getRes.json();
          data.quizzes = data.quizzes || [];
          // Upsert by quizName on server copy
          const idx = data.quizzes.findIndex(q => q.quizName === quizRecord.quizName);
          if (idx >= 0) data.quizzes[idx] = quizRecord; else data.quizzes.push(quizRecord);
          const ok = await trySync(data);
          if (ok) return;
        }
      } catch (e) {
        // fallthrough to local save
      }
    }
    // Save locally
    const raw = localStorage.getItem('progressData');
    let payload = { subjects: [], quizzes: [] };
    if (raw) {
      try { payload = JSON.parse(raw); } catch(e) { payload = { subjects: [], quizzes: [] }; }
    }
    const idx2 = payload.quizzes.findIndex(q => q.quizName === quizRecord.quizName);
    if (idx2 >= 0) payload.quizzes[idx2] = quizRecord; else payload.quizzes.push(quizRecord);
    localStorage.setItem('progressData', JSON.stringify(payload));
    // Best-effort: also write the attempt to Firestore when available
    try {
      if (window.db && window.auth && window.auth.currentUser) {
        await writeQuizAttemptToFirestore(quizRecord, quizRecord.topic || currentUploadedPdfName || null);
      }
    } catch (ee) {
      // ignore failures (local/save to server remains authoritative)
    }
  } catch (e) {
    console.error('recordQuizResult error', e);
  }
}


goToProgressBtn.addEventListener("click", () => {
  goProg();
});

// Keep the in-quiz restart behaviour (reload) intact if the element exists
if (typeof restartBtn !== 'undefined' && restartBtn) {
  // existing listener already attached earlier; no override here
} else {
  const rb = document.getElementById("restartQuiz");
  if (rb) rb.addEventListener("click", () => location.reload());
}

// Safe navigation handlers for performance dashboard buttons
const restartPerfBtn = document.getElementById("restartQuizPerf");
if (restartPerfBtn) restartPerfBtn.onclick = () => { window.location.href = "quiz.html"; };
const goToProgressPerfBtn = document.getElementById("goToProgressPerf");
if (goToProgressPerfBtn) goToProgressPerfBtn.onclick = () => { window.location.href = "progress.html"; };
const goToProgressBtnEl = document.getElementById("goToProgressBtn");
if (goToProgressBtnEl) goToProgressBtnEl.onclick = () => { window.location.href = "progress.html"; };
// Enhance button hover and keyboard focus for better UX

document.addEventListener('DOMContentLoaded', () => {
  loadCategories();
  [normalQuizBtn,pdfQuizBtn,startNormalQuizBtn,startPdfQuizBtn].forEach(btn => {
     if(btn) btn.onkeyup = (e) => { if(e.key==="Enter" || e.key===" ") { btn.click(); }};
  });
  // wire local/offline PDF buttons
  if (generateOfflinePdfBtn) {
    generateOfflinePdfBtn.addEventListener('click', async () => {
      if (!pdfInput.files || pdfInput.files.length === 0) { alert('Please upload a PDF file first.'); return; }
      const file = pdfInput.files[0];
      const reader = new FileReader();
      reader.onload = function() {
        const typedarray = new Uint8Array(this.result);
    // Avoid attempting to load the worker from the CDN (which fails when offline).
    // Use the main-thread parser via disableWorker:true to ensure robust offline parsing.
    const loadingTask = pdfjsLib.getDocument({ data: typedarray, disableWorker: true });
        loadingTask.promise.then(async function(pdf) {
          let fullText = '';
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const content = await page.getTextContent();
            const strings = content.items.map(item => item.str);
            fullText += strings.join(' ') + ' ';
          }
          const amount = 50;
          let generated = null;
          const fileName = file.name.replace(/\.[^/.]+$/, '');
          const topic = (pdfTopicName && pdfTopicName.value.trim()) ? pdfTopicName.value.trim() : fileName;

          // Prefer server-side Gemini generation when online. Server uses GEMINI_API_KEY from .env.
          if (navigator.onLine) {
            generateOfflinePdfBtn.disabled = true;
            try {
              showToast('Generating 50 questions via server (this may take a few moments)...');
              const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: fullText, amount: amount, difficulty: pdfDifficultySelect.value })
              };
              // Validator: accept only when data.quiz is an array with at least 1 item (preferably full amount)
              const validator = (res, data) => {
                if (!data) return false;
                if (!Array.isArray(data.quiz)) return false;
                // Prefer at least 50 items; allow fewer but require at least 1
                return data.quiz.length >= Math.max(1, Math.floor(amount * 0.5));
              };
              try {
                const { res, data } = await fetchWithRetries(`${BACKEND_URL}/generate-quiz`, options, 5, 1500, validator);
                if (data && Array.isArray(data.quiz) && data.quiz.length > 0) {
                  generated = data.quiz.map(it => {
                    if (it.question && it.options && it.answer) {
                      return { question: it.question, correct_answer: it.answer, incorrect_answers: it.options.filter(o=>o!==it.answer) };
                    }
                    return it;
                  });
                }
              } catch (e) {
                console.warn('Server generation failed after retries, falling back to local generator', e);
              }
            } finally {
              generateOfflinePdfBtn.disabled = false;
            }
          }

          // Fallback to a local generator if server couldn't produce questions
          if (!generated) {
            generated = localQuestionGenerator(fullText, amount);
          }

          // Prepare document object and overwrite existing doc with same name/pdfName if present
          let doc = {
            id: 'pdf-' + Date.now(),
            name: topic,
            pdfName: file.name,
            createdAt: new Date().toISOString(),
            pages: pdf.numPages,
            generatedQuiz: generated,
            lastScore: null,
            lastUpdated: null
          };
          try {
            // IMPORTANT: do NOT overwrite any existing saved quiz. Create a new saved
            // document so the user's previous saved quizzes remain until they explicitly
            // delete them.
            const savedId = await saveDocument(doc);
            currentDocId = savedId || doc.id;
            showToast('Offline quiz saved locally');
            await renderLocalQuizList();
          } catch (e) {
            console.error('Failed to save offline quiz', e);
            alert('Failed to save offline quiz: ' + (e.message || e));
          }
        }, function(reason) {
          alert('Error loading PDF: ' + reason);
        });
      };
      reader.readAsArrayBuffer(file);
    });
  }
  if (takeOfflineQuizBtn) {
    takeOfflineQuizBtn.addEventListener('click', async () => {
      await renderLocalQuizList();
      const panel = document.getElementById('local-quizzes');
      if (panel) {
        // expand dropdown if collapsed and scroll into view
        panel.classList.remove('collapsed');
        panel.classList.add('expanded');
        panel.scrollIntoView({behavior: 'smooth'});
      }
    });
  }
  // render any existing local quizzes
  renderLocalQuizList();
  // Ensure the dropdown header has its click handler wired so the header toggle works
  try { wireLocalQuizzesHeader(); } catch (e) { /* ignore if not available yet */ }
});

// --- Local quizzes dropdown behavior ---
function ensureLocalQuizzesDropdown() {
  const panel = document.getElementById('local-quizzes');
  if (!panel) return;
  // If header already exists, ensure it has wiring
  const existingHeader = panel.querySelector('.dropdown-header');
  if (existingHeader) { wireLocalQuizzesHeader(); return; }

  // Create header
  const header = document.createElement('button');
  header.className = 'dropdown-header';
  header.type = 'button';
  header.innerHTML = `<span>Locally Stored Quizzes (Offline)</span><span class="caret">▾</span>`;

  // Move existing title (if any) and list into dropdown body
  const body = document.createElement('div');
  body.className = 'dropdown-body';
  // The existing UL is inside panel; move it into body
  const ul = panel.querySelector('#localQuizList');
  if (!ul) return;
  body.appendChild(ul);

  // Clear panel and append header + body
  panel.innerHTML = '';
  panel.appendChild(header);
  panel.appendChild(body);

  // Start collapsed by default
  panel.classList.add('collapsed');

  header.addEventListener('click', () => {
    const caret = header.querySelector('.caret');
    if (panel.classList.contains('collapsed')) {
      panel.classList.remove('collapsed');
      panel.classList.add('expanded');
      if (caret) caret.style.transform = 'rotate(0deg)';
      // refresh list in case it changed
      renderLocalQuizList();
    } else {
      panel.classList.add('collapsed');
      panel.classList.remove('expanded');
      if (caret) caret.style.transform = 'rotate(-90deg)';
    }
  });
}

// Attach click handler to an existing header (used when header is provided in HTML)
function wireLocalQuizzesHeader() {
  const panel = document.getElementById('local-quizzes');
  if (!panel) return;
  const header = panel.querySelector('.dropdown-header');
  if (!header) return;
  // Avoid attaching multiple listeners
  if (header.__wired) return;
  header.__wired = true;
  const caret = header.querySelector('.caret');
  header.addEventListener('click', () => {
    if (panel.classList.contains('collapsed')) {
      panel.classList.remove('collapsed');
      panel.classList.add('expanded');
      if (caret) caret.style.transform = 'rotate(0deg)';
      renderLocalQuizList();
    } else {
      panel.classList.add('collapsed');
      panel.classList.remove('expanded');
      if (caret) caret.style.transform = 'rotate(-90deg)';
    }
  });
  // set initial caret rotation according to state
  if (panel.classList.contains('collapsed')) {
    if (caret) caret.style.transform = 'rotate(-90deg)';
  } else {
    if (caret) caret.style.transform = 'rotate(0deg)';
  }
}

// Make PDF flow enable dropdown UI when opened
if (pdfQuizBtn) {
  const originalPdfClick = pdfQuizBtn.onclick;
  pdfQuizBtn.onclick = (e) => {
    // call original behavior
    try { if (originalPdfClick) originalPdfClick(e); } catch(_){}
    // Ensure dropdown header exists and collapse it by default
    ensureLocalQuizzesDropdown();
    const panel = document.getElementById('local-quizzes');
    if (panel) {
      panel.classList.add('collapsed');
      panel.classList.remove('expanded');
      // keep small visual presence; user can expand
      panel.scrollIntoView({behavior: 'smooth'});
    }
  };
}

// Initialize app
loadCategories();
