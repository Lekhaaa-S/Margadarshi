const pdfInput = document.getElementById('pdfInput');
const summarizeBtn = document.getElementById('summarizeBtn');
const summaryOutput = document.getElementById('summaryOutput');
const summaryLengthSelect = document.getElementById('summaryLength');
const savedList = document.getElementById('savedList');

// Small floating toast helper
function showToast(message, ms = 3000) {
  try {
    console.log('showToast:', message);
    let toast = document.getElementById('app-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-toast';
      Object.assign(toast.style, {
        padding: '10px 14px',
        background: 'rgba(26,26,68,0.95)',
        color: 'white',
        borderRadius: '8px',
        boxShadow: '0 6px 18px rgba(0,0,0,0.2)',
        opacity: '0',
        transition: 'opacity 200ms ease'
      });
      // Attach to toast-root if present, otherwise fallback to body
      const root = document.getElementById('toast-root');
      if (root) root.appendChild(toast); else document.body.appendChild(toast);
    }
    toast.textContent = message;
    // Force reflow then show
    void toast.offsetWidth;
    toast.style.opacity = '1';
    // Hide after ms
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { try { if (toast && toast.parentNode) toast.parentNode.removeChild(toast); } catch (e) {} }, 300);
    }, ms);
  } catch (e) {
    // noop
    console.warn('showToast error', e);
  }
}

// Ensure a fixed-position toast container exists so toasts are visible above the UI
window.addEventListener('load', () => {
  try {
    if (!document.getElementById('toast-root')) {
      const root = document.createElement('div');
      root.id = 'toast-root';
      // Try to place the toast root directly below the saved summaries section
      const saved = document.getElementById('savedList');
      if (saved && saved.parentNode) {
        Object.assign(root.style, {
          display: 'block',
          marginTop: '12px',
          pointerEvents: 'none'
        });
        saved.parentNode.insertBefore(root, saved.nextSibling);
      } else {
        // Fallback: fixed top-right
        Object.assign(root.style, {
          position: 'fixed',
          right: '20px',
          top: '20px',
          zIndex: 99999,
          pointerEvents: 'none'
        });
        document.body.appendChild(root);
      }
    }
  } catch (e) {
    console.warn('Failed to create toast-root', e);
  }
});

// IndexedDB helpers (simple wrapper)
const DB_NAME = 'summaries-db';
const DB_STORE = 'summaries';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// saveSummaryLocal can be called two ways:
// - saveSummaryLocal(filename, summaryText)
// - saveSummaryLocal(summaryText)  // for offline-only saves where we only want to persist the summary
async function saveSummaryLocal(a, b) {
  let filename;
  let summaryText;
  if (b === undefined) {
    // called with single arg -> treat as summaryText only
    filename = '';
    summaryText = a;
  } else {
    filename = a;
    summaryText = b;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    const item = { summary: summaryText, created: Date.now() };
    if (filename) item.filename = filename;
    const req = store.add(item);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllSummaries() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore(DB_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteSummary(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function renderSavedList() {
  if (!savedList) return;
  const items = await getAllSummaries();
  if (!items.length) {
    savedList.innerHTML = '<p>No saved summaries yet.</p>';
    return;
  }
  savedList.innerHTML = '';
  items.sort((a,b)=>b.created-a.created);
  items.forEach(item => {
    const div = document.createElement('div');
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.gap = '10px';
    div.style.marginBottom = '8px';
    const name = document.createElement('span');
    // If filename was not provided (offline-only save), show a short snippet of the summary
    if (item.filename) {
      name.textContent = item.filename;
    } else if (item.summary) {
      name.textContent = (item.summary.length > 60) ? item.summary.slice(0, 57) + '...' : item.summary;
    } else {
      name.textContent = 'Saved summary';
    }
    name.style.flex = '1';
    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'View';
    viewBtn.onclick = () => { summaryOutput.value = item.summary; };
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.onclick = async () => { await deleteSummary(item.id); await renderSavedList(); };
    div.appendChild(name);
    div.appendChild(viewBtn);
    div.appendChild(delBtn);
    savedList.appendChild(div);
  });
}

// Render saved list on load
window.addEventListener('load', () => {
  renderSavedList().catch(console.error);
});

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').then(reg => {
    console.log('Service Worker registered', reg);
    console.log('SW scope:', reg.scope);
    if (reg.installing) console.log('SW installing');
    if (reg.waiting) console.log('SW waiting');
    if (reg.active) console.log('SW active');
    // After registration, ensure the service worker precaches assets on first visit.
    // navigator.serviceWorker.ready resolves when the service worker is active.
    navigator.serviceWorker.ready.then(activeReg => {
      try {
        if (activeReg && activeReg.active) {
          activeReg.active.postMessage({ type: 'PRECACHE' });
          console.log('PRECACHE message sent to active service worker');
        }
      } catch (e) {
        console.warn('Failed to send PRECACHE to SW', e);
      }
    }).catch(err => console.warn('serviceWorker.ready failed', err));
  }).catch(err => console.warn('SW registration failed', err));
}

// Debug panel bindings
window.addEventListener('load', () => {
  const precacheBtn = document.getElementById('precacheBtn');
  const dumpCacheBtn = document.getElementById('dumpCacheBtn');
  const dumpIdbBtn = document.getElementById('dumpIdbBtn');
  const debugOutput = document.getElementById('debugOutput');
  if (precacheBtn) precacheBtn.onclick = () => {
    debugOutput.textContent = 'Sending PRECACHE to service worker (waiting for ready)...';
    if (navigator.serviceWorker) {
      navigator.serviceWorker.ready.then(reg => {
        if (reg && reg.active) {
          reg.active.postMessage({ type: 'PRECACHE' });
          debugOutput.textContent = 'PRECACHE message sent to active service worker.';
        } else {
          debugOutput.textContent = 'Service worker ready but no active worker found.';
        }
      }).catch(err => {
        debugOutput.textContent = 'navigator.serviceWorker.ready failed: ' + err.message;
      });
    } else {
      debugOutput.textContent = 'Service workers not supported in this browser.';
    }
  };
  if (dumpCacheBtn) dumpCacheBtn.onclick = async () => {
    debugOutput.textContent = 'Inspecting caches...';
    try {
      const keys = await caches.keys();
      let out = '';
      for (const k of keys) {
        out += `Cache: ${k}\n`;
        const cache = await caches.open(k);
        const reqs = await cache.keys();
        for (const r of reqs) out += `  - ${r.url}\n`;
      }
      debugOutput.textContent = out || 'No cache entries found';
    } catch (e) {
      debugOutput.textContent = 'Cache inspect failed: ' + e.message;
    }
  };
  if (dumpIdbBtn) dumpIdbBtn.onclick = async () => {
    debugOutput.textContent = 'Reading IndexedDB...';
    try {
      const items = await getAllSummaries();
      debugOutput.textContent = JSON.stringify(items, null, 2);
    } catch (e) {
      debugOutput.textContent = 'IndexedDB read failed: ' + e.message;
    }
  };
});

// Enable summarize button only if file selected
pdfInput.addEventListener('change', () => {
  summarizeBtn.disabled = !pdfInput.files.length;
  summaryOutput.value = '';
});

// Simulated offline check to disable the button when offline
window.addEventListener('online', () => {
  summarizeBtn.disabled = !pdfInput.files.length;
});
window.addEventListener('offline', () => {
  // Keep the button enabled if a file is already selected so offline summarization can run.
  summarizeBtn.disabled = !pdfInput.files.length;
});

// Upload the PDF to the Flask backend and request a summary
summarizeBtn.addEventListener('click', async () => {
  if (!pdfInput.files.length) return;
  // remove any previous offline-save button when starting a new request
  removeSaveOfflineButton();
  const file = pdfInput.files[0];
  const words = summaryLengthSelect.value || '100';

  // If offline, perform client-side summarization using pdf.js + extractive algorithm
  if (!navigator.onLine) {
    try {
      showToast('You are offline', 3000);
      summaryOutput.value = 'Generating offline summary...';
      summarizeBtn.disabled = true;
      const text = await extractTextFromPdfClient(file);
      const offlineSummary = summarizeTextExtractive(text, parseInt(words, 10) || 200);
      const display = '[Offline extractive summary]\n\n' + offlineSummary;
      summaryOutput.value = display;
      showSaveOfflineButton(offlineSummary, file && file.name ? file.name : '');
      // Ask SW to cache the current page
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'CACHE_CURRENT', url: window.location.href });
        }
      } catch (e) { console.warn('Failed to notify SW', e); }
    } catch (err) {
      summaryOutput.value = 'Offline summary failed: ' + err.message;
        showToast('You are offline', 3000);
        // run offline fallback
      summarizeBtn.disabled = false;
    }
    return;
  }

  summaryOutput.value = 'Summarizing PDF... please wait.';
  summarizeBtn.disabled = true;
  const form = new FormData();
  form.append('file', file);
  form.append('words', words);

  // Retry loop: try repeatedly until we get a summary or reach max attempts
  const delayMs = 4000; // 4 seconds between attempts
  const maxAttempts = 100; // safety cap (100 attempts => ~400s)

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  let attempt = 0;
  let lastError = null;
  // Keep the UI quiet about intermediate attempts; server/terminal will show attempt logs.
  summaryOutput.value = 'Summarizing PDF... please wait';
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      // When the Flask apps are composed under a single runner the summarizer
      // backend is mounted at `/summarizer`. Use that path so POSTs reach the
      // correct app regardless of mount configuration.
      // Try the mounted summarizer endpoint first (used when apps are composed),
      // then fall back to the root `/summarize` path for standalone runs.
      const endpoints = ['/summarizer/summarize', '/summarize'];
      let resp = null;
      let lastFetchError = null;
      for (const ep of endpoints) {
        try {
          resp = await fetch(ep, { method: 'POST', body: form });
        } catch (err) {
          lastFetchError = err;
          resp = null;
        }
        // If we received a response that is not 405, accept it (may be ok or other error)
        if (resp && resp.status !== 405) break;
        // otherwise try next endpoint
        resp = null;
      }
      if (!resp && lastFetchError) throw lastFetchError;

      // Try to parse JSON even on non-OK to get error details
      let data = null;
      try {
        data = await resp.json();
      } catch (e) {
        data = null;
      }

      if (resp.ok && data && data.summary) {
        summaryOutput.value = data.summary;
        // save locally
        try {
          await saveSummaryLocal(file.name || ('pdf-' + Date.now()), data.summary);
          // refresh saved list
          renderSavedList().catch(console.error);
          // Notify service worker to precache assets and cache current page state
          try {
            const msg = { type: 'PRECACHE' };
            // helper to post message to active worker or wait for ready
            function postMessageToSW(message) {
              if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage(message);
              } else if (navigator.serviceWorker && navigator.serviceWorker.ready) {
                navigator.serviceWorker.ready.then(reg => {
                  if (reg.active) reg.active.postMessage(message);
                }).catch(console.warn);
              }
            }
            postMessageToSW(msg);
            // Also request the service worker to cache the current page URL so the latest UI is available offline
            postMessageToSW({ type: 'CACHE_CURRENT', url: window.location.href });
          } catch (e) {
            console.warn('Failed to notify service worker for precache', e);
          }
        } catch (e) {
          console.warn('Failed to save summary locally', e);
        }
        lastError = null;
        // ensure any offline-save button is removed after successful server save
        removeSaveOfflineButton();
        break; // success
      }

      // Not a successful summary: capture error and retry (silent)
      if (data && data.error) {
        lastError = `Server error: ${data.error}`;
      } else if (!resp.ok) {
        lastError = `HTTP ${resp.status} ${resp.statusText} ${data && data.error ? '- ' + data.error : ''}`;
      } else {
        lastError = 'No summary returned from server.';
      }
    } catch (err) {
      // If fetch failed due to network (server stopped/unreachable), fall back to client summarizer.
      lastError = 'Network error: ' + err.message;
      console.warn('Fetch to /summarize failed:', err);
      try {
        // Run client-side summarizer as a fallback (do not save the offline result)
        summaryOutput.value = 'Server unreachable — generating offline fallback summary...';
        const text = await extractTextFromPdfClient(file);
        const offlineSummary = summarizeTextExtractive(text, parseInt(words, 10) || 200);
        summaryOutput.value = '[Fallback offline extractive summary]\n\n' + offlineSummary;
        showSaveOfflineButton(offlineSummary, file && file.name ? file.name : '');
        // clear lastError so the post-loop error message is not shown
        lastError = null;
      } catch (fallbackErr) {
        summaryOutput.value = 'Offline fallback failed: ' + (fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr));
      }
      // stop retrying
      break;
    }

    // Wait before next attempt
    await sleep(delayMs);
  }

  if (lastError) {
    summaryOutput.value = `Failed after ${attempt} attempts. Last error: ${lastError} (see server terminal for attempt logs).`;
  }

  summarizeBtn.disabled = false;
});

// Logout function (keeps original behavior)
function logout() {
  localStorage.removeItem('user');
  sessionStorage.removeItem('user');
  window.location.href = 'home.html';
}

// -------------------------
// Client-side PDF extraction using pdf.js
// -------------------------
async function extractTextFromPdfClient(file) {
  if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js not loaded');
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
  } catch (e) {
    // ignore
  }
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  let fullText = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items.map(item => item.str);
    fullText += strings.join(' ') + '\n\n';
  }
  return fullText;
}

// -------------------------
// Simple extractive summarizer
// -------------------------
function summarizeTextExtractive(text, targetWords = 200) {
  if (!text || !text.trim()) return '';
  // split roughly into sentences
  const sentenceDelim = /(?<=[.?!])\s+(?=[A-Z0-9])/g;
  let sentences = text.replace(/\s+/g, ' ').split(sentenceDelim).map(s => s.trim()).filter(Boolean);
  if (sentences.length === 0) return text.slice(0, 1000);

  const stopWords = new Set(['the','and','is','in','at','of','a','to','for','with','on','that','this','it','as','are','was','be','by','an','or','from','which','but','not','have','has','had','we','they','their','its','can','will','these']);
  const wordRe = /[a-zA-Z0-9]+/g;
  const freq = new Map();
  for (const s of sentences) {
    const words = s.toLowerCase().match(wordRe) || [];
    for (const w of words) {
      if (stopWords.has(w) || w.length <= 2) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  if (freq.size === 0) return sentences.slice(0, Math.min(3, sentences.length)).join(' ');

  const scored = sentences.map((s,i) => {
    const words = s.toLowerCase().match(wordRe) || [];
    let score = 0;
    for (const w of words) if (freq.has(w)) score += freq.get(w);
    return { i, s, score, length: s.split(/\s+/).length };
  });

  scored.sort((a,b) => b.score - a.score);
  const chosen = [];
  let count = 0;
  for (const item of scored) {
    chosen.push(item);
    count += item.length;
    if (count >= targetWords) break;
  }
  chosen.sort((a,b) => a.i - b.i);
  return chosen.map(c => c.s).join(' ');
}

// -------------------------
// Save-offline button helpers
// -------------------------
function showSaveOfflineButton(summaryText, filename = '') {
  try {
    removeSaveOfflineButton();
    const btn = document.createElement('button');
    btn.id = 'saveOfflineBtn';
    btn.textContent = 'Save this offline summary';
    Object.assign(btn.style, {
      marginTop: '8px',
      marginLeft: '8px',
      padding: '8px 12px',
      borderRadius: '8px',
      cursor: 'pointer'
    });
    btn.onclick = async () => {
      try {
        // save with original filename when available
        if (filename) await saveSummaryLocal(filename, summaryText);
        else await saveSummaryLocal(summaryText);
        await renderSavedList();
        showToast('Offline summary saved', 2000);
        removeSaveOfflineButton();
      } catch (e) {
        console.error('Failed to save offline summary', e);
        showToast('Failed to save', 3000);
      }
    };
    const out = document.getElementById('summaryOutput');
    if (out && out.parentNode) {
      out.parentNode.insertBefore(btn, out.nextSibling);
    } else {
      document.body.appendChild(btn);
    }
  } catch (e) {
    console.warn('showSaveOfflineButton error', e);
  }
}

function removeSaveOfflineButton() {
  try {
    const b = document.getElementById('saveOfflineBtn');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  } catch (e) { /* noop */ }
}
