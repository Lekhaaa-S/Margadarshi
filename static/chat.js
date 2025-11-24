// chat.js - CORRECTED VERSION

// When this page is served under a mount prefix (for example '/chat'),
// using relative URLs ensures API calls target the same mounted app.
// Keep FLASK_BASE_URL empty so older code paths that used it don't produce
// absolute requests to the site root (which break when mounted under a prefix).
const FLASK_BASE_URL = "";

// Determine API mount prefix from the current path (helps when the app is mounted)
const KNOWN_PREFIXES = ['/chat', '/study', '/quiz'];
let API_PREFIX = '';
try {
    const p = (window.location && window.location.pathname) ? window.location.pathname : '';
    API_PREFIX = KNOWN_PREFIXES.find(pref => p === pref || p.startsWith(pref + '/')) || '';
} catch (e) {
    API_PREFIX = '';
}

function _ensureLeadingSlash(s) {
    if (!s) return '/';
    return s.startsWith('/') ? s : '/' + s;
}

function _makePath(path) {
    // path may already include query string
    if (!path) path = '';
    // remove any leading slash from path so concatenation is predictable
    path = path.replace(/^\/+/, '');
    return API_PREFIX + '/' + path;
}

// Robust fetch helper: try mounted-relative first, then fall back to absolute Flask origin
async function apiFetch(path, options) {
    const rel = _makePath(path);
    // Try mounted-relative first (works when page is served from the composed Flask server)
    try {
        console.debug('apiFetch trying (relative):', rel);
        const r = await fetch(rel, options);
        if (r && r.ok) return r;
        // If response exists but not ok, continue to fallbacks
    } catch (e) {
        console.debug('apiFetch relative failed, trying fallbacks', e);
    }

    // Fallbacks to try on the Flask origin. Try common mounted prefixes so
    // requests still work if the page was opened from a static dev server (Live Server).
    const origin = 'http://127.0.0.1:5000';
    const candidates = [
        // try whatever API_PREFIX we detected
        origin + _makePath(path),
        // common mounts
        origin + '/chat/' + path.replace(/^\/+/, ''),
        origin + '/study/' + path.replace(/^\/+/, ''),
        // last resort: root
        origin + '/' + path.replace(/^\/+/, '')
    ];

    for (const url of candidates) {
        try {
            console.debug('apiFetch trying fallback:', url);
            const r = await fetch(url, options);
            if (r && r.ok) return r;
        } catch (e) {
            console.debug('apiFetch fallback failed for', url, e);
        }
    }

    // If all attempts failed, throw the last error by performing one final fetch
    // to the primary origin path so the caller can inspect the response/error.
    return fetch(origin + _makePath(path), options);
}

// --- Firebase Configuration (Assuming firebaseConfig is defined elsewhere) ---
// You MUST ensure firebaseConfig is defined BEFORE this script runs, typically 
// in a separate <script> block in your HTML.
if (!firebase.apps.length) {
    // This line assumes firebaseConfig is a globally available constant defined 
    // in your bookmarks.html or similar file.
    // Example: const firebaseConfig = { apiKey: "...", ... };
    firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db = firebase.firestore();

let currentUser = null; 
let uploadedFile = null;
let uploadedFileURL = null;
let chatHistory = [];
let selectedMessages = new Set();
let quoteIndex = 0;
let hasSentWelcomeMessage = false; // New flag to control welcome message

// DOM Elements
const chatContainer = document.getElementById('chatContainer');
const chatForm = document.getElementById('chatForm');
const promptInput = document.getElementById('prompt');
const fileBtn = document.getElementById('fileBtn');
const fileInput = document.getElementById('fileInput');
const filePreview = document.getElementById('filePreview');
const submitBtn = document.getElementById('submitBtn');
const typingIndicator = document.getElementById('typingIndicator');
const motivationBanner = document.getElementById('motivationBanner');
const actionBar = document.getElementById('actionBar');
const selectedCount = document.getElementById('selectedCount');

// Global safeguard: capture any submit event and prevent navigation (guard against unexpected form submits)
document.addEventListener('submit', function (e) {
    try { e.preventDefault(); e.stopImmediatePropagation(); } catch (ex) { console.warn('submit-capture failed', ex); }
}, true);




// --- Initialization ---
auth.onAuthStateChanged(user => {
    if (user) {
        console.log("User logged in:", user.email);
        currentUser = user;
        // 1. Load previous chats first
        loadPreviousChatsFromServer(user.uid);
    } else {
        console.log("User not logged in");
        currentUser = null;
        // Clear chat history if user logs out
        chatHistory = [];
        renderChatHistory();
    }
});


async function sendInitialProfileMessage(userId) {
    if (hasSentWelcomeMessage) return; // Prevent multiple sends

    try {
        const doc = await db.collection("users").doc(userId).get();
        let welcomeMessage = "";

        if (doc.exists) {
            const data = doc.data();
            const name = data.name || "Student";
            const examGoal = data.examGoal || "my academic goals";
            const futureAim = data.futureAim || "my future aspirations";
            welcomeMessage = `👋 Hey ${name}! Welcome back to **Margadarshi** 🌟  
    I see your goal is **${examGoal}**, and your dream is to become **${futureAim}** — that’s truly inspiring! 💪  
    So tell me, would you like to start exploring a topic today, or shall I share something motivating to boost your focus?`;

            } else {
                welcomeMessage = `👋 Welcome to **Margadarshi** — your personal AI study mentor! 📘  
    I can help you set goals, stay motivated, and explore topics you love.  
    Would you like to tell me your study goals, or shall we begin with something motivational today?`;

            }

        // 🧠 Simulate AI typing first, then render as AI message
        setTimeout(() => {
            typingIndicator.style.display = "flex";
            setTimeout(() => {
                typingIndicator.style.display = "none";
                const aiTimestamp = formatTimestamp();
                const aiChat = createChatMessage(
                    welcomeMessage,
                    false, // AI message (not user)
                    null,
                    chatHistory.length,
                    aiTimestamp
                );
                chatContainer.appendChild(aiChat);
                // Push to local history
                const newIndex = chatHistory.length;
                chatHistory.push({
                    role: 'ai',
                    text: welcomeMessage,
                    timestamp: aiTimestamp,
                    doc_id: null
                });

                // Persist the AI-only welcome message to Firestore so every conversation
                // (including system/welcome prompts) is saved. Use the new /saveChat endpoint.
                try {
                    (async () => {
                        const res = await apiFetch('saveChat', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ user_id: userId, message: '', reply: welcomeMessage })
                        });
                        if (res && res.ok) {
                            const j = await res.json();
                            const id = j.doc_id;
                            // update local history and rendered DOM with doc_id for deletion/editing later
                            chatHistory[newIndex].doc_id = id;
                            try { aiChat.dataset.docId = id; } catch (e) { /* ignore */ }
                        } else {
                            console.warn('Failed to persist welcome message', await (res ? res.text() : Promise.resolve('no response')));
                        }
                    })();
                } catch (e) { console.warn('saveChat call failed', e); }
                chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
                hasSentWelcomeMessage = true;
            }, 1500); // typing delay
        }, 500);
    } catch (error) {
        console.error("Error fetching profile for welcome message:", error);
    }
}



// Navigation functions (keeping them as is)
function goHome() { window.location.href = "index.html"; }
function logout() {
    auth.signOut().then(() => { // Use Firebase signOut
        localStorage.removeItem('user');
        sessionStorage.removeItem('user');
        window.location.href = "home.html";
    }).catch(error => {
        console.error("Logout failed", error);
    });
}
function openProfile() { window.location.href = "profile.html"; }

// Quotes (keeping them as is)
const quotes = [
    "Success is not the key to happiness. Happiness is the key to success.",
    "Push yourself, because no one else is going to do it for you.",
    "Dream bigger. Do bigger.",
    "Don’t watch the clock; do what it does. Keep going.",
    "Great things never come from comfort zones."
];
function rotateQuote() {
    motivationBanner.textContent = quotes[quoteIndex];
    quoteIndex = (quoteIndex + 1) % quotes.length;
}
setInterval(rotateQuote, 8000);
rotateQuote();

// --- Formatting and Utility ---

function renderMarkdown(text) {
    if (!text) return '';
    // Escape HTML first
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = esc(text);
    // Bold, italic, links
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    // Convert double-newlines to paragraphs, single-newline to <br>
    html = html.split('\n\n').map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
    return html;
}

function formatTimestamp(date = new Date()) {
    // If date is an ISO string, convert it to a Date object first
    if (typeof date === 'string') {
        date = new Date(date);
    }
    return date.toLocaleString('en-IN', {
        hour: '2-digit', minute: '2-digit', day: '2-digit',
        month: 'short', year: 'numeric'
    });
}

function createChatMessage(message, isUser = false, fileMeta = null, index = null, timestamp = null) {
    const container = document.createElement('div');
    container.classList.add('chat-message-container', isUser ? 'user-message' : 'ai-message');
    container.dataset.index = index;
    // Store doc_id on the user message container for deletion
    if (isUser && chatHistory[index] && chatHistory[index].doc_id) {
        container.dataset.docId = chatHistory[index].doc_id;
    }


    // Avatar wrapper
    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'avatar-wrap';
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = isUser ? 'user.png' : 'ai.png';
    avatar.alt = isUser ? 'User' : 'Margadarshi AI';
    avatarWrap.appendChild(avatar);

    // Content wrapper
    const content = document.createElement('div');
    content.className = 'content-wrap';

    const chatBox = document.createElement('div');
    chatBox.classList.add('chat-box');
    
    // --- Enhanced File Display ---
    if (fileMeta && isUser) { 
        // 1. Question Asked
        // Check if the message contains the file prefix and if there's any actual question text after it
        const filePrefix = message.match(/\[(Image|PDF):.*?\]\s*/);
        const cleanMessage = message.replace(/\[(Image|PDF):.*?\]\s*/, '').trim(); 
        
        if (cleanMessage) {
            const questionDiv = document.createElement('div');
            questionDiv.className = 'question-asked';
            questionDiv.innerHTML = `<span class="question-label">Question:</span> ${renderMarkdown(cleanMessage)}`;
            chatBox.appendChild(questionDiv);
        }

        // 2. File Preview Container
        const filePreviewContainer = document.createElement('div');
        filePreviewContainer.className = 'file-preview-container';

        // Normalize returned file URL so it's relative to the current page.
        // If the server returned an absolute URL (http...), use it unchanged.
        // If it returned a path starting with '/', strip the leading slash
        // to make the resource request relative to the current mount prefix.
        let fileURL;
        if (/^https?:\/\//i.test(fileMeta.url)) {
            fileURL = fileMeta.url;
        } else if (/^data:/i.test(fileMeta.url)) {
            // data: URLs (inline previews) should be used as-is and not rewritten
            fileURL = fileMeta.url;
        } else {
            // Normalize returned file URL so it's requested from the correct mount.
            // If the page is served from the root (e.g. /chat.html) but the chat
            // backend is mounted at `/chat`, a bare `/uploads/...` will 404.
            // Use the detected API_PREFIX when available, otherwise fall back to
            // the known chat mount to construct a correct path.
            const pathNoLeading = fileMeta.url.replace(/^\/+/, '');
            const mount = (API_PREFIX && API_PREFIX.length) ? API_PREFIX : '/chat';
            // Ensure single slash joining
            fileURL = mount.replace(/\/$/, '') + '/' + pathNoLeading;
        }
        
        if (fileMeta.type?.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = fileURL;
            img.className = 'uploaded-preview';
            img.alt = fileMeta.name;
            img.title = 'Click to view full image';
            
            const imgContainer = document.createElement('div');
            imgContainer.className = 'image-preview-wrapper';
            imgContainer.onclick = () => window.open(fileURL, '_blank');
            imgContainer.appendChild(img);
            filePreviewContainer.appendChild(imgContainer);
            
        } else if (fileMeta.type?.startsWith('application/pdf')) {
            const pdfPreview = document.createElement('div');
            pdfPreview.className = 'pdf-preview';
            
            const pdfIcon = document.createElement('span');
            pdfIcon.className = 'pdf-icon';
            pdfIcon.innerHTML = '📄';
            
            const pdfName = document.createElement('span');
            pdfName.className = 'pdf-name';
            pdfName.textContent = fileMeta.name;
            
            const previewBtn = document.createElement('button');
            previewBtn.className = 'open-pdf-btn';
            previewBtn.textContent = 'Open PDF';
            previewBtn.onclick = () => window.open(fileURL, '_blank');
            
            pdfPreview.appendChild(pdfIcon);
            pdfPreview.appendChild(pdfName);
            pdfPreview.appendChild(previewBtn);
            filePreviewContainer.appendChild(pdfPreview);
        }
        
        chatBox.appendChild(filePreviewContainer);
    } else {
        // Normal text message or AI reply
        chatBox.innerHTML = renderMarkdown(message);
    }
    

    const timeSpan = document.createElement('div');
    timeSpan.classList.add('message-timestamp');
    timeSpan.textContent = timestamp || formatTimestamp();
    chatBox.appendChild(timeSpan);

    content.appendChild(chatBox);

    // Build container with avatar and content in correct order
    if (isUser) {
        container.appendChild(content);
        container.appendChild(avatarWrap);
    } else {
        container.appendChild(avatarWrap);
        container.appendChild(content);
    }

    // Selection logic (keeping as is)
    container.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.closest('a')) return;
        if (index === null) return; // Ignore selection for messages without an index

        if (selectedMessages.has(index)) {
            selectedMessages.delete(index);
            container.classList.remove('selected');
        } else {
            // Only allow selection of user message OR AI reply, but in pairs
            const pairIndex = isUser ? index + 1 : index - 1;
            
            // Clear current selection if we're starting a new pair selection
            if (selectedMessages.size > 0 && (!selectedMessages.has(pairIndex) && !selectedMessages.has(index))) {
                 // Deselect all others first for clean pair selection
                 document.querySelectorAll('.chat-message-container.selected').forEach(el => {
                    el.classList.remove('selected');
                 });
                 selectedMessages.clear();
            }

            selectedMessages.add(index);
            container.classList.add('selected');
            
            // Auto-select the corresponding message in the pair if it exists
            if (chatHistory[pairIndex]) {
                selectedMessages.add(pairIndex);
                document.querySelector(`.chat-message-container[data-index="${pairIndex}"]`)?.classList.add('selected');
            }
        }
        updateActionBar();
    });

    return container;
}

// Rebuild the chat container from the chatHistory array (keeping as is)
function renderChatHistory() {
    chatContainer.innerHTML = '';
    chatHistory.forEach((m, i) => {
        const isUser = m.role === 'user';
        // Note: m.text might be empty for a file upload if the user didn't type a question
        chatContainer.appendChild(createChatMessage(m.text || '', isUser, m.fileMeta || null, i, m.timestamp || null));
    });
    updateActionBar();
    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
}


fileBtn.addEventListener('click', () => { fileInput.click(); });
// Defensive: ensure the file input is not associated with the form to avoid implicit submits
try {
    if (fileInput) {
        // remove form association
        fileInput.removeAttribute('form');
        fileInput.addEventListener('click', (e) => { e.stopPropagation(); });
    }
} catch (e) { console.warn('Could not detach file input from form', e); }

// Ensure submit button explicitly calls handler (some browsers may still submit forms)
if (submitBtn && !submitBtn._hasClickHandler) {
    submitBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (promptInput.value.trim() || uploadedFile) {
            submitBtn.disabled = true;
            try {
                await handleUserMessage(promptInput.value || '');
            } catch (err) { console.error('handleUserMessage error', err); }
            submitBtn.disabled = false;
        }
    });
    submitBtn._hasClickHandler = true;
}
// File Input Change Listener (Keeping logic to update preview as is)
fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    uploadedFile = file;
    const reader = new FileReader();
    reader.onload = function (e) {
        uploadedFileURL = e.target.result;
        filePreview.innerHTML = '';
        const isImage = file.type.startsWith('image/');

        // Create the preview element
        const previewElement = isImage ? document.createElement('img') : document.createElement('span');
        
        if (isImage) {
            previewElement.src = uploadedFileURL;
            previewElement.alt = "Uploaded Preview";
        } else {
            previewElement.textContent = `📎 ${file.name}`;
        }
        
        previewElement.title = "Click to remove";
        previewElement.classList.add('file-preview-item');
        
        // Remove handler
        const removeHandler = () => {
            uploadedFile = null;
            uploadedFileURL = null;
            filePreview.innerHTML = '';
            fileInput.value = '';
            filePreview.style.display = 'none';
        };

        if (isImage) {
            previewElement.onclick = removeHandler;
            filePreview.appendChild(previewElement);
        } else {
            filePreview.appendChild(previewElement);
            const rem = document.createElement('div');
            rem.textContent = 'Remove';
            rem.classList.add('remove-preview');
            rem.onclick = removeHandler;
            filePreview.appendChild(rem);
        }
        
        filePreview.style.display = 'flex';
    };
    reader.readAsDataURL(file);
});

// Update Action Bar (keeping as is)
function updateActionBar() {
    // Only allow editing if ONLY ONE user message is selected
    const selectedUserMessages = Array.from(selectedMessages)
        .filter(i => chatHistory[i] && chatHistory[i].role === 'user');
        
    const editBtn = document.querySelector('.action-buttons button[onclick="editSelected()"]');
    const deleteBtn = document.querySelector('.action-buttons button[onclick="deleteSelected()"]');

    if (selectedMessages.size > 0) {
        editBtn.style.display = (selectedUserMessages.length === 1 && selectedMessages.size <= 2) ? "inline-block" : "none";
        deleteBtn.style.display = "inline-block";
        actionBar.style.display = 'flex';
        selectedCount.textContent = `${selectedMessages.size} selected`;
    } else {
        editBtn.style.display = "none";
        deleteBtn.style.display = "none";
        actionBar.style.display = 'none';
    }
}

// AI Response Fetch
async function getAIResponse(userMessage) {
    const userId = currentUser ? currentUser.uid : "guest";
    const response = await apiFetch(`chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, text: userMessage })
    });
    const data = await response.json();
    // The server now returns the doc_id
    return { reply: data.reply || "⚠️ No response", doc_id: data.doc_id || null };
}

// File Upload Logic
async function uploadFile(file, question) {
    const userId = currentUser ? currentUser.uid : "guest";
    const formData = new FormData();
    formData.append("file", file);
    formData.append("user_id", userId);
    formData.append("question", question);

    const endpoint = file.type.includes("pdf") ? "uploadPDF" : "uploadImage";

    typingIndicator.style.display = "flex";
    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });

    try {
        // FIX: The res variable was missing the assignment
            const res = await apiFetch(`${endpoint}?nocache=${Date.now()}`, {
                method: "POST",
                cache: "no-store",
                body: formData
            });

        typingIndicator.style.display = "none";

        if (!res.ok) {
            const errorText = await res.text();
            console.error("AI response failed:", errorText);
            return { reply: "⚠️ AI response failed.", file_url: null, doc_id: null };
        }

        const data = await res.json();
        const file_url = data.file_url || `${FLASK_BASE_URL}/uploads/${data.filename}`;
        
        // Server now returns doc_id
        return { 
            reply: data.reply || "⚠️ No AI response", 
            file_url: file_url,
            doc_id: data.doc_id || null
        };
    } catch (err) {
        typingIndicator.style.display = "none";
        console.error("Upload error:", err);
        return { reply: "⚠️ Upload failed.", file_url: null, doc_id: null };
    }
}


// --- Main Message Handler ---
async function handleUserMessage(message) {
    const currentMessage = message.trim();
    if (!currentMessage && !uploadedFile) return;

    const timestamp = formatTimestamp(); 

    // Create the file metadata for the chat history/display
    const fileMetaForDisplay = uploadedFile ? {
        name: uploadedFile.name,
        type: uploadedFile.type,
        url: uploadedFileURL 
    } : null;
    
    // Combine file prefix with message text for history/backend
    const userMessageText = fileMetaForDisplay 
        ? `[${fileMetaForDisplay.type.includes("pdf") ? 'PDF' : 'Image'}: ${fileMetaForDisplay.name}] ${currentMessage}`
        : currentMessage;


    // 1️⃣ Render user message immediately (doc_id will be null initially)
    const userChat = createChatMessage(
        userMessageText,
        true,
        fileMetaForDisplay,
        chatHistory.length,
        timestamp
    );
    chatContainer.appendChild(userChat);

    // Save user message to history (doc_id will be added later)
    const userHistoryIndex = chatHistory.length;
    chatHistory.push({
        role: 'user',
        text: userMessageText, // Save combined text
        timestamp,
        fileMeta: fileMetaForDisplay,
        doc_id: null // Placeholder
    });

    const fileToUpload = uploadedFile;
    const questionText = currentMessage;

    // Clear input/preview for the next message
    promptInput.value = '';
    
    // Reset file preview immediately (it's safe now that fileToUpload holds the object)
    if(fileToUpload) {
        uploadedFile = null;
        uploadedFileURL = null;
        filePreview.style.display = 'none';
        filePreview.innerHTML = '';
        fileInput.value = ''; // Reset the hidden file input
    }
    
    typingIndicator.style.display = "flex";
    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });

    let aiResponse = "";
    let docId = null;

    try {
        let result;
        if (fileToUpload) {
            result = await uploadFile(fileToUpload, questionText);
        } else {
            result = await getAIResponse(questionText);
        }
        
        aiResponse = result.reply;
        docId = result.doc_id;

        // 2️⃣ Update user message in history with the actual doc_id
        chatHistory[userHistoryIndex].doc_id = docId;
        // Also update the DOM element's dataset
        userChat.dataset.docId = docId;

        // If the upload returned a server file URL, update the stored fileMeta
        // so future renders request the correct server-hosted URL instead of
        // the temporary data: URL used for preview. Also update the DOM img src
        // in-place so the user sees the server-hosted image after upload.
        if (result.file_url) {
            try {
                if (chatHistory[userHistoryIndex].fileMeta) {
                    chatHistory[userHistoryIndex].fileMeta.url = result.file_url;
                }
                // update rendered DOM img if present
                const imgEl = userChat.querySelector('img.uploaded-preview');
                if (imgEl) {
                    imgEl.src = result.file_url;
                }
            } catch (e) {
                console.warn('Failed to update uploaded file URL in DOM/history', e);
            }
        }


    } catch (err) {
        console.error("Error getting AI response:", err);
        aiResponse = "⚠️ AI failed to respond.";
    }

    typingIndicator.style.display = "none";

    // 3️⃣ Render AI reply instantly after fetch with current timestamp
    const aiTimestamp = formatTimestamp();
    const aiChat = createChatMessage(aiResponse, false, null, chatHistory.length, aiTimestamp);
    chatContainer.appendChild(aiChat);
    chatHistory.push({
        role: 'ai',
        text: aiResponse,
        timestamp: aiTimestamp
    });

    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
}


// --- Load History Logic (ISSUE 2 FIX) ---
async function loadPreviousChatsFromServer(userId) {
    if (!userId) return;
    const res = await apiFetch(`getChats/${userId}`);
    if (!res.ok) {
        console.error("Failed to fetch chats from server", await res.text());
        return;
    }
    const chats = await res.json();
    chatHistory = [];
    chatContainer.innerHTML = "";

    chats.forEach((c, i) => {
        const message = c.message || "";
        const reply = c.reply || "";
        const fileMeta = c.fileMeta || null;
        const doc_id = c.doc_id || null; // Retrieve doc_id from backend

        let chatTime = c.timestamp ? formatTimestamp(c.timestamp) : formatTimestamp();

        // User message
        const userIndex = chatHistory.length;
        chatContainer.appendChild(createChatMessage(message, true, fileMeta, userIndex, chatTime));
        chatHistory.push({ role: 'user', text: message, fileMeta, timestamp: chatTime, doc_id: doc_id });

        // AI reply MUST USE THE SAME TIMESTAMP as the user message for the pair
        const aiIndex = chatHistory.length;
        chatContainer.appendChild(createChatMessage(reply, false, null, aiIndex, chatTime));
        chatHistory.push({ role: 'ai', text: reply, timestamp: chatTime });
    });

    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });

    // 2. Call profile message function AFTER loading history
    if (chats.length === 0) {
        sendInitialProfileMessage(userId);
    }
}


chatForm.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    if (promptInput.value.trim() || uploadedFile) {
        await handleUserMessage(promptInput.value);
        submitBtn.style.boxShadow = '0 0 0 4px var(--accent)';
        setTimeout(() => submitBtn.style.boxShadow = '', 120);
    }
});

// FIX 1: Prevent page refresh on pressing Enter in the textarea
promptInput.addEventListener('keydown', async function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); 
        if (promptInput.value.trim() || uploadedFile) {
            await handleUserMessage(promptInput.value.trim());
        }
    }
});

// --- Action Functions ---

// New function to delete chat from Firestore
async function deleteSelectedFromFirestore(userId, docId) {
    try {
        const res = await apiFetch(`deleteChat/${userId}/${docId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error("Server failed to delete chat.");
        return true;
    } catch (error) {
        console.error("Firestore Delete Error:", error);
        alert(`Error deleting chat: ${error.message}`);
        return false;
    }
}

function deleteSelected() {
    if (!currentUser) {
        alert("Please log in to delete messages.");
        return;
    }
    if (!confirm('Are you sure you want to delete the selected message pair(s)?')) return;

    const indicesToDelete = Array.from(selectedMessages).sort((a, b) => b - a);
    const userId = currentUser.uid;
    let successfulDeletes = 0;
    
    // Collect the user messages to delete (which hold the doc_id)
    const userMessagesToDelete = indicesToDelete
        .filter(i => chatHistory[i]?.role === 'user')
        .map(i => chatHistory[i]);
        
    const deletePromises = userMessagesToDelete.map(msg => 
        deleteSelectedFromFirestore(userId, msg.doc_id)
    );

    Promise.all(deletePromises).then(results => {
        // Filter out history only for successfully deleted items
        const successfullyDeletedIndices = [];
        results.forEach((success, index) => {
            if (success) {
                // Find the original index of the user message and its AI reply
                const originalIndex = chatHistory.findIndex(m => m.doc_id === userMessagesToDelete[index].doc_id);
                if (originalIndex !== -1) {
                    // Mark both user and AI message for local deletion
                    successfullyDeletedIndices.push(originalIndex);
                    // Check if the AI reply is the next index
                    if (chatHistory[originalIndex + 1] && chatHistory[originalIndex + 1].role === 'ai') {
                         successfullyDeletedIndices.push(originalIndex + 1);
                    }
                }
            }
        });
        
        // Remove from local chatHistory
        const finalIndicesToDelete = [...new Set(successfullyDeletedIndices)].sort((a, b) => b - a);

        finalIndicesToDelete.forEach(i => {
            chatHistory.splice(i, 1);
        });

        selectedMessages.clear();
        renderChatHistory();
        alert(`Deleted ${results.filter(r => r).length} chat pair(s).`);

    }).catch(error => {
        console.error("Batch delete failed:", error);
        alert("An error occurred during batch deletion.");
    });
}


async function bookmarkSelected() {
    if (!currentUser) {
        alert("Please log in first.");
        return;
    }

    const userId = currentUser.uid;
    const selectedAI = Array.from(selectedMessages)
        .map(i => chatHistory[i])
        .filter(m => m && m.role === 'ai');

    if (selectedAI.length === 0) {
        alert("No AI messages selected.");
        return;
    }

    for (const msg of selectedAI) {
        try {
            // Save bookmark locally (offline-first). Do not rely on server-side bookmarks anymore.
            try { updateBookmarksCache(userId, msg.text); } catch(e) { console.warn('cache update failed', e); }
        } catch (e) {
            console.error('Local bookmark save failed:', e);
        }
    }

    alert("Bookmarked (saved locally)!");
    selectedMessages.clear();
    renderChatHistory(); // Re-render to clear selection
}

function copySelected() {
    const selectedText = Array.from(selectedMessages).map(i => chatHistory[i]?.text).join('\n\n');
    navigator.clipboard.writeText(selectedText).then(() => {
        alert('Copied to clipboard!');
        selectedMessages.clear();
        renderChatHistory();
    });
}

function editSelected() {
    // Logic remains mostly the same: remove pair and put user text in input
    if (selectedMessages.size === 1 || selectedMessages.size === 2) {
        const selectedUserIndex = Array.from(selectedMessages).find(i => chatHistory[i]?.role === 'user');

        if (selectedUserIndex !== undefined) {
            const msg = chatHistory[selectedUserIndex];
            promptInput.value = msg.text.replace(/\[(Image|PDF):.*?\]\s*/, '').trim(); // Remove file prefix for editing
            
            // Remove the selected user message and the subsequent AI reply
            const aiIndex = selectedUserIndex + 1;
            
            // Delete from Firestore (Note: this is an edit, so we should delete the old record)
            if (currentUser && msg.doc_id) {
                 deleteSelectedFromFirestore(currentUser.uid, msg.doc_id);
            }
            
            // Remove locally (AI message first, then user message)
            if (chatHistory.length > aiIndex && chatHistory[aiIndex].role === 'ai') {
                chatHistory.splice(aiIndex, 1);
            }
            chatHistory.splice(selectedUserIndex, 1);

            selectedMessages.clear();
            renderChatHistory();
        } else {
            alert("Select one user message to edit.");
            selectedMessages.clear();
            updateActionBar();
        }
    } else {
        alert("Select only one message pair to edit.");
        selectedMessages.clear();
        updateActionBar();
    }
}
// 🚀 NEW FUNCTION: Clear all chats from the database and trigger welcome message
async function clearAllChats() {
    if (!currentUser) {
        alert("Please log in to clear chats.");
        return;
    }
    const userId = currentUser.uid;
    if (confirm("Are you sure you want to delete ALL your chats? This cannot be undone.")) {
        try {
            const response = await apiFetch(`clearAllChats/${userId}`, { method: 'DELETE' });
            if (response.ok) {
                // 1. Clear local history and re-render
                chatHistory = [];
                selectedMessages.clear();
                hasSentWelcomeMessage = false; // 2. Crucial: Reset flag to allow welcome message
                renderChatHistory();
                
                alert("All chats cleared successfully! Starting fresh.");

                // 3. Send the profile/welcome message immediately
                await sendInitialProfileMessage(userId); 
            } else {
                const errorData = await response.json();
                alert(`Failed to clear chats: ${errorData.error || response.statusText}`);
            }
        } catch (e) {
            console.error("Clear All Chats error:", e);
            alert("An error occurred while trying to clear all chats.");
        }
    }
}

// --- Bookmark cache helpers ---
function updateBookmarksCache(userId, text) {
    try {
        if (!userId || !text) return;
        const key = `bookmarks_cache_${userId}`;
        const now = new Date().toISOString();
        let existing = [];
        try { existing = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { existing = []; }
        // avoid duplicate exact texts
        if (!existing.find(e => e.text === text)) {
            existing.unshift({ id: `local_${Date.now()}`, text, timestamp: now });
        }
        localStorage.setItem(key, JSON.stringify(existing.slice(0, 200)));
        localStorage.setItem('bookmarks_cache_last_user', userId);
    } catch (e) { console.warn('updateBookmarksCache failed', e); }
}

function clearBookmarksCache(userId) {
    try { if (!userId) return; localStorage.removeItem(`bookmarks_cache_${userId}`); localStorage.removeItem('bookmarks_cache_last_user'); } catch(e) {}
}