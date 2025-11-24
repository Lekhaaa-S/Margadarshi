// study2.js (Complete Code with Shared AI Integration - FULL FILE)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getDatabase, ref, push, onValue, onChildAdded, set } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-database.js";
import { getAuth, signOut } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js";

// ✅ Firebase configuration 
// Obtain firebase config from a server-injected global to avoid committing keys in the repo.
// On the server render your HTML with something like:
// <script>window.__FIREBASE_CONFIG__ = { apiKey: "...", authDomain: "...", ... }</script>
// Ensure that script runs before this JS file is loaded.
if (!window.__FIREBASE_CONFIG__) {
    throw new Error('Missing firebase config. Inject config server-side as window.__FIREBASE_CONFIG__');
}
const firebaseConfig = window.__FIREBASE_CONFIG__;

// --- Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// --- Persistent User Storage
let userId = localStorage.getItem("userId");
let username = localStorage.getItem("username");

if (!userId) {
    userId = "user-" + Date.now();
    localStorage.setItem("userId", userId);
}
if (!username) {
    username = prompt("Enter your display name") || "User";
    localStorage.setItem("username", username);
}

// --- Global Variables
let currentRoomId = null;
let currentPasscode = null;
let messagesListenerAttached = false;
const AI_USER_ID = "AI_Study_Partner_ID"; // Unique ID for the AI

let currentQuizWatcherUnsub = null;

// --- Utility: Timestamp Format
function formatTimestamp(ts) {
    if (!ts) return "";
    return new Date(Number(ts)).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

// --- DOM Elements ---
const roomModal = document.getElementById("roomModal");
const mainLayout = document.getElementById("mainLayout");
const createRoomBtn = document.getElementById("createRoomBtn");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

const groupChatBox = document.getElementById("groupChatBox");
const aiChatBox = document.getElementById("aiChatBox");
const fileInput = document.getElementById("fileInput");
const roomIdDisplay = document.getElementById("roomIdDisplay");
const passcodeDisplay = document.getElementById("passcodeDisplay");

// --- AI Tab Elements ---
const aiTab = document.getElementById("aiTab");
const groupTab = document.getElementById("groupTab");

// --- Header Controls ---
const logoutBtn = document.getElementById("logoutBtn");
const homeBtn = document.getElementById("homeBtn");

// --- Quiz & Leaderboard Elements ---
const startQuizBtn = document.getElementById("startQuizBtn");
const viewLeaderboardBtn = document.getElementById("viewLeaderboardBtn");
const quizContainer = document.getElementById("quizContainer");
const leaderboardContainer = document.getElementById("leaderboardContainer");

// --- ROOM CREATION ---
if (createRoomBtn) {
    createRoomBtn.addEventListener("click", () => {
        const displayNameInput = document.getElementById("displayNameInput");
        if (!displayNameInput || !displayNameInput.value.trim()) {
            showToast("Enter display name", "#e11d48");
            return;
        }
        username = displayNameInput.value.trim();
        localStorage.setItem("username", username);

        currentRoomId = "room" + Math.floor(Math.random() * 9000 + 1000);
        currentPasscode = Math.floor(Math.random() * 9000 + 1000);

        set(ref(db, `rooms/${currentRoomId}`), { passcode: currentPasscode })
            .then(() => {
                showToast("✅ Room created successfully!");
                openRoom();
            })
            .catch((err) => console.error("Create room error:", err));
    });
}

// --- HOME BUTTON ---
if (homeBtn) {
    homeBtn.addEventListener("click", () => {
        window.location.href = "index.html";
    });
}

// Logout handler for Study Room
if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
        try {
            const auth = getAuth();
            await signOut(auth);
        } catch (e) {
            console.warn('Firebase signOut failed or not configured:', e);
        }
        // Clear local user state used by this module
        try { localStorage.removeItem('userId'); localStorage.removeItem('username'); } catch (e) {}
        // Best-effort server logout
        try { await fetch('/logout', { method: 'GET', credentials: 'include' }); } catch (e) {}
        // Redirect to public home page
        try { window.location.href = 'home.html'; } catch (e) { /* ignore */ }
    });
}

// --- JOIN ROOM FLOW ---
const joinRoomBtn = document.getElementById("joinRoomBtn");
const roomJoinForm = document.getElementById("roomJoinForm");
const doJoinBtn = document.getElementById("doJoinBtn");
const joinRoomIdInput = document.getElementById("joinRoomId");
const joinPasscodeInput = document.getElementById("joinPasscode");

if (joinRoomBtn && roomJoinForm) {
    joinRoomBtn.addEventListener("click", () => {
        roomJoinForm.classList.toggle("hidden");
    });
}

if (doJoinBtn) {
    doJoinBtn.addEventListener("click", () => {
        const displayNameInput = document.getElementById("displayNameInput");
        if (!displayNameInput.value.trim()) {
            showToast("Enter display name", "#e11d48");
            return;
        }
        username = displayNameInput.value.trim();
        localStorage.setItem("username", username);

        const roomId = joinRoomIdInput.value.trim();
        const passcode = joinPasscodeInput.value.trim();
        if (!roomId || !passcode) return showToast("Enter Room ID and Passcode", "#e11d48");
        joinRoom(roomId, passcode);
    });

}

// Ensure form submit doesn't reload the page - delegate to the same join handler
const roomJoinFormEl = document.getElementById('roomJoinForm');
if (roomJoinFormEl) {
    roomJoinFormEl.addEventListener('submit', (e) => {
        try {
            e.preventDefault();
            // trigger the same join logic used by doJoinBtn
            if (doJoinBtn) doJoinBtn.click();
        } catch (err) {
            console.error('roomJoinForm submit handler error', err);
        }
    });
}

// --- JOIN ROOM FUNCTION ---
function joinRoom(roomId, passcode) {
    const roomRef = ref(db, `rooms/${roomId}/passcode`);
    onValue(
        roomRef,
        (snapshot) => {
            if (!snapshot.exists()) return showToast("❌ Room not found", "#e11d48");
            if (snapshot.val() != passcode) return showToast("Wrong passcode", "#e11d48");

            currentRoomId = roomId;
            currentPasscode = passcode;
            showToast("✅ Joined the room successfully!");

            // FIX: Clear the inputs and hide the join form after successful join
            if (roomJoinForm) roomJoinForm.classList.add("hidden");
            if (joinRoomIdInput) joinRoomIdInput.value = '';
            if (joinPasscodeInput) joinPasscodeInput.value = '';

            openRoom();
        }, { onlyOnce: true }
    );
}

// --- OPEN ROOM UI (FIX APPLIED HERE) ---
function openRoom() {
    roomModal.classList.add("hidden");
    mainLayout.classList.remove("hidden");

    roomIdDisplay.innerText = "Room ID: " + currentRoomId;
    passcodeDisplay.innerText = "Passcode: " + currentPasscode;

    // Sharing link logic removed as requested.

    // Attach message listener and clear chat on open
    listenMessages();
    // start watching currentQuiz for auto-finalize / UI updates
    watchCurrentQuiz();

}

// --- Unified Message Display Function ---
function displayMessage(chatBoxElement, msg) {
    const div = document.createElement("div");

    // Determine the class based on sender (AI, You, or Other)
    if (msg.sender === userId) {
        div.className = "msg me";
    } else if (msg.sender === AI_USER_ID) {
        div.className = "msg ai";
    } else {
        div.className = "msg other";
    }

    const displayName = msg.sender === userId ? "You" : (msg.sender === AI_USER_ID ? "🤖 AI Partner" : msg.username || "User");

    // Logic for rendering text or file messages
    if (msg.fileData) {
        const fileType = msg.fileType || "";
        if (fileType.startsWith("image/")) {
            div.innerHTML = `<b>${displayName}:</b><br><img src="${msg.fileData}" style="max-width:400px;border-radius:8px;margin-top:6px;">`;
        } else if (fileType === "application/pdf") {
            let base64Data = msg.fileData;
            if (base64Data.startsWith("data:")) {
                base64Data = base64Data.split(",")[1];
            }
            const blob = b64toBlob(base64Data, fileType);
            const url = URL.createObjectURL(blob);
            div.innerHTML = `<b>${displayName}:</b> <a href="${url}" target="_blank">${msg.fileName || "PDF File"}</a>`;
        } else {
            div.innerHTML = `<b>${displayName}:</b> <a href="${msg.fileData}" download="${msg.fileName || "File"}">${msg.fileName || "File"}</a>`;
        }
    } else if (msg.text) {
        div.innerHTML = `<b>${displayName}:</b> ${msg.text}`;
    }

    const timeEl = document.createElement("div");
    timeEl.className = "msg-time";
    timeEl.style.fontSize = "0.75em";
    timeEl.style.color = "#666";
    timeEl.innerText = formatTimestamp(msg.timestamp);
    div.appendChild(timeEl);

    // If this message refers to a quiz, add a 'Take Quiz' button
    if (msg.quizId) {
        const takeBtn = document.createElement('button');
        takeBtn.className = 'btn';
        takeBtn.style.marginLeft = '8px';
        takeBtn.innerText = 'Take Quiz';
        takeBtn.addEventListener('click', () => {
            openQuizPanel(msg.quizId);
        });
        div.appendChild(takeBtn);
    }

    chatBoxElement.appendChild(div);
    chatBoxElement.scrollTop = chatBoxElement.scrollHeight;
}


// 🐍 Python-Gemini AI Integration Functions (Connects to server.py) 🐍
// ---------------------------------------------------------------------

// --- Utility: Convert Data URL to Base64 String (Removes 'data:mime/type;base64,') ---
function cleanDataURL(dataUrl) {
    // This is robust against data URL formats
    const parts = dataUrl.split(',');
    return parts.length > 1 ? parts[1] : dataUrl;
}


// --- Function to communicate with your Python backend server (server.py) ---
async function sendQueryToGemini(query, filePayload = null) {
    // This URL MUST match the address and port of your running Python server (Flask)
    // use mount-aware api path (apiFetch) instead of hardcoded port
    const serverPath = 'ask-ai';
    const maxRetries = 3; // Maximum number of times to try the request
    let lastError = null;

    // 1. Client-Side Silent Retry Loop
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // SILENT DELAY: Wait before the second and subsequent attempts (1s, then 2s).
            if (attempt > 1) {
                // The interface will just appear to be loading longer.
                await new Promise(r => setTimeout(r, 1000 * (attempt - 1)));
            }

            const payload = {
                prompt: query,
                roomId: currentRoomId,
                file: filePayload ? {
                    data: cleanDataURL(filePayload.data), // Clean Base64 string
                    mimeType: filePayload.mimeType
                } : null
            };

            const response = await apiFetch(serverPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            // 2. Check for Server Response Status
            if (response.ok) {
                // SUCCESS! The server is back online and responded.
                const data = await response.json();
                return data.text;
            } else if (response.status === 503 || response.status === 429) {
                // 503 (Unavailable/Overloaded) or 429 (Rate Limit) are retryable errors
                const errorData = await response.json().catch(() => ({ error: 'Unknown server error.' }));
                lastError = new Error(`Server Error (${response.status}): ${errorData.error}`);

                if (attempt === maxRetries) {
                    throw lastError; // Throw on the final failed attempt
                }
                // The loop continues silently, waiting for the next attempt
            } else {
                // Other non-retryable error (e.g., 400 Bad Request) - fail immediately
                const errorData = await response.json().catch(() => ({ error: 'Unknown server error.' }));
                throw new Error(`Server Error (${response.status}): ${errorData.error}`);
            }
        } catch (e) {
            lastError = e;
            // If max retries reached or it's a critical network error, the function throws.
            if (attempt === maxRetries) {
                // The calling function will catch this and display a failure message.
                throw lastError;
            }
            // If not max retries, the loop continues for the next attempt (silent delay)
        }
    }

    // Fallback for safety
    throw lastError || new Error("AI service completely unreachable after retries.");
}
// ---------------------------------------------------------------------

// --- LISTEN FOR MESSAGES ---
function listenMessages() {
    if (!currentRoomId) return;

    if (messagesListenerAttached) return;
    const messagesRef = ref(db, `rooms/${currentRoomId}/messages`);
    // Listen for new messages pushed to the room
    onChildAdded(messagesRef, (snapshot) => {
        const msg = snapshot.val();
        if (!msg) return;

        // 1. Display in Group Chat Box (for all messages)
        displayMessage(groupChatBox, msg);

        // 2. CRITICAL FIX: Display ALL messages in the AI chat tab as well.
        // This ensures the full conversation (user prompts + AI responses) 
        // from everyone is shared in the AI tab, and fixes the synchronization issue.
        displayMessage(aiChatBox, msg);
    });
    messagesListenerAttached = true;
}

// --- FILE UPLOAD ---
if (fileInput) {
    fileInput.addEventListener("change", async() => {
        const file = fileInput.files[0];
        if (!file || !currentRoomId) return showToast("Please join a room to share files.", "#e11d48");

        // The AI tab logic now handles file upload and message creation for AI mode.
        // This block handles regular group chat file sharing.
        if (aiTab.classList.contains("selected")) {
            // Do nothing here, the sendBtn handler will manage the AI file
            return;
        }

        const reader = new FileReader();
        reader.onload = async function() {
            const base64Data = reader.result;
            await push(ref(db, `rooms/${currentRoomId}/messages`), {
                sender: userId,
                username: username,
                fileName: file.name,
                fileType: file.type,
                fileData: base64Data,
                timestamp: Date.now()
            });
            showToast("📎 File shared successfully!");
            fileInput.value = "";
        };
        reader.readAsDataURL(file);
    });
}

// --- Base64 → Blob (Utility for downloading files) ---
function b64toBlob(b64Data, contentType = "", sliceSize = 512) {
    const byteCharacters = atob(b64Data);
    const byteArrays = [];

    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
        const slice = byteCharacters.slice(offset, offset + sliceSize);
        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) {
            byteNumbers[i] = slice.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        byteArrays.push(byteArray);
    }

    return new Blob(byteArrays, { type: contentType });
}

// --- Toast Notification ---
function showToast(msg, color = "#2563eb") {
    let toast = document.createElement("div");
    toast.innerText = msg;
    toast.style.position = "fixed";
    toast.style.bottom = "20px";
    toast.style.right = "20px";
    toast.style.background = color;
    toast.style.color = "#fff";
    toast.style.padding = "12px 16px";
    toast.style.borderRadius = "8px";
    toast.style.boxShadow = "0 3px 10px rgba(0,0,0,0.25)";
    toast.style.zIndex = "1000";
    toast.style.fontWeight = "600";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}

// --- AUTO JOIN VIA URL ---
// Removed this block as requested, forcing manual Room ID and Passcode entry.


// --- Tab switching (Group vs AI) ---
if (groupTab && aiTab) {
    groupTab.addEventListener('click', () => {
        groupTab.classList.add('selected');
        aiTab.classList.remove('selected');
        groupChatBox.classList.remove('hidden');
        aiChatBox.classList.add('hidden');
    });
    aiTab.addEventListener('click', () => {
        aiTab.classList.add('selected');
        groupTab.classList.remove('selected');
        aiChatBox.classList.remove('hidden');
        groupChatBox.classList.add('hidden');
    });
}


// --- QUIZ & LEADERBOARD LOGIC ---

// Top-level Start Quiz handler and helpers (host flow)
if (startQuizBtn) {
    // Show the quiz creation modal instead of using multiple prompt() dialogs
    startQuizBtn.addEventListener("click", () => {
        if (!currentRoomId) return showToast("Join a room to start a group quiz.", "#e11d48");
        const quizModal = document.getElementById('quizModal');
        if (!quizModal) return showToast('Quiz modal not found.', '#e11d48');
        quizModal.classList.remove('hidden');
        // populate defaults
        const quizNameInput = document.getElementById('quizNameInput');
        const numQuestionsInput = document.getElementById('numQuestionsInput');
        const perQuestionTimeInput = document.getElementById('perQuestionTimeInput');
        if (quizNameInput) quizNameInput.value = '';
        if (numQuestionsInput) numQuestionsInput.value = '3';
        if (perQuestionTimeInput) perQuestionTimeInput.value = '30';
    });
}

// Quiz modal handlers
const quizModalEl = document.getElementById('quizModal');
if (quizModalEl) {
    const quizSubmitBtn = document.getElementById('quizSubmitBtn');
    const quizCancelBtn = document.getElementById('quizCancelBtn');
    const quizNameInput = document.getElementById('quizNameInput');
    const numQuestionsInput = document.getElementById('numQuestionsInput');
    const perQuestionTimeInput = document.getElementById('perQuestionTimeInput');
    const quizFileInput = document.getElementById('quizFileInput');

    quizCancelBtn && quizCancelBtn.addEventListener('click', () => {
        quizModalEl.classList.add('hidden');
    });

    quizSubmitBtn && quizSubmitBtn.addEventListener('click', async() => {
        // collect & validate
        const quizName = (quizNameInput && quizNameInput.value && quizNameInput.value.trim()) ? quizNameInput.value.trim() : null;
        const numQuestions = parseInt((numQuestionsInput && numQuestionsInput.value) || '0', 10) || 0;
        const perQTime = parseInt((perQuestionTimeInput && perQuestionTimeInput.value) || '30', 10) || 30;
        if (!quizName) return showToast('Quiz name is required.', '#e11d48');
        if (!numQuestions || numQuestions < 1) return showToast('Enter a valid number of questions.', '#e11d48');

        // handle optional file
        let file = null;
        if (quizFileInput && quizFileInput.files && quizFileInput.files.length > 0) {
            file = quizFileInput.files[0];
            if (!file.type || !file.type.includes('pdf')) return showToast('Please upload a PDF file for source material or leave it empty.', '#e11d48');
        }

        // close modal while generating
        quizModalEl.classList.add('hidden');
        quizContainer.classList.remove('hidden');
        leaderboardContainer.classList.add('hidden');

        const startedAt = Date.now();
        await push(ref(db, `rooms/${currentRoomId}/messages`), {
            sender: AI_USER_ID,
            username: '🤖 AI Partner',
            text: `Quiz generation started: ${quizName} — generating ${numQuestions} questions...`,
            timestamp: startedAt,
            quizId: String(startedAt)
        });

        // prepare file payload if present
        let filePayload = null;
        if (file) {
            try {
                const dataUrl = await readFileAsDataURL(file);
                const base64Data = cleanDataURL(dataUrl);
                filePayload = { data: base64Data, mimeType: file.type };
            } catch (err) {
                console.error('readFile error', err);
                return showToast('Failed to read uploaded PDF.', '#e11d48');
            }
        }

        // call backend
        const generateResult = await generateQuizBackend({ roomId: currentRoomId, quizName, numQuestions, file: filePayload });

        // fallback to local mock if needed
        let finalQuizData = null;
        if (!generateResult || generateResult.error) {
            console.warn('generateQuizBackend failed', generateResult);
            showToast('AI generation failed. Using a local mock quiz.', '#f59e0b');
            const mockQuestions = [];
            for (let i = 0; i < numQuestions; i++) {
                mockQuestions.push({ question: `Placeholder question ${i + 1} (AI unavailable)`, options: ['Option A', 'Option B', 'Option C', 'Option D'], answer: 'A' });
            }
            finalQuizData = { quizName, questions: mockQuestions };
        } else {
            finalQuizData = generateResult;
        }

        const quizObj = {
            quizName: finalQuizData.quizName || quizName,
            questions: finalQuizData.questions || [],
            startedBy: userId,
            startedByName: username,
            startedAt: startedAt,
            quizId: String(startedAt),
            perQuestionTime: perQTime,
            totalTime: (numQuestions * perQTime) + (5 * 60),
            endAt: Date.now() + ((numQuestions * perQTime) + (5 * 60)) * 1000,
            submissions: {}
        };

        await set(ref(db, `rooms/${currentRoomId}/currentQuiz`), quizObj);

        await push(ref(db, `rooms/${currentRoomId}/messages`), {
            sender: AI_USER_ID,
            username: '🤖 AI Partner',
            text: `Quiz started: ${quizObj.quizName} — Click to take the quiz!`,
            timestamp: Date.now(),
            quizId: String(quizObj.startedAt)
        });

        showToast('Quiz ready and broadcast to the room.', '#10b981');
    });
}

// Helper: wait for the user to select a file via the fileInput element
function waitForFileSelection(timeoutMs = 120000) {
    return new Promise((resolve) => {
        const fileEl = document.getElementById('fileInput');
        if (!fileEl) return resolve(null);

        const onChange = () => {
            fileEl.removeEventListener('change', onChange);
            const file = fileEl.files[0];
            resolve(file || null);
        };

        fileEl.addEventListener('change', onChange);
        fileEl.click();

        // Timeout fallback
        setTimeout(() => {
            fileEl.removeEventListener('change', onChange);
            resolve(null);
        }, timeoutMs);
    });
}

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Call backend /generate-quiz endpoint
async function generateQuizBackend(payload) {
    try {
        const resp = await apiFetch('generate-quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await resp.json();
        return data;
    } catch (err) {
        console.error('generateQuizBackend error', err);
        return { error: 'Network or server error' };
    }
}

if (viewLeaderboardBtn) {
    viewLeaderboardBtn.addEventListener("click", () => {
        quizContainer.classList.add("hidden");
        leaderboardContainer.classList.remove("hidden");
        loadLeaderboard();
    });
}

function loadLeaderboard() {
    if (!currentRoomId) return;
    // quizResults may be organized per-quiz: rooms/<roomId>/quizResults/<quizId>/<userId>
    const leaderboardRef = ref(db, `rooms/${currentRoomId}/quizResults`);
    onValue(leaderboardRef, (snapshot) => {
        const all = snapshot.val() || {};
        // Aggregate cumulative scores per user
        const agg = {};
        Object.keys(all).forEach(quizId => {
            const perQuiz = all[quizId] || {};
            Object.keys(perQuiz).forEach(uid => {
                const entry = perQuiz[uid];
                if (!agg[uid]) agg[uid] = { username: entry.username || uid, score: 0 };
                agg[uid].score += Number(entry.score || 0);
            });
        });

        const sorted = Object.values(agg).sort((a, b) => b.score - a.score);
        let leaderboardHTML = "<h3>🏆 Leaderboard</h3><ol>";
        if (sorted.length === 0) {
            leaderboardHTML += "<li>No quiz scores recorded yet.</li>";
        } else {
            sorted.forEach(userScore => {
                leaderboardHTML += `<li>${userScore.username}: <b>${userScore.score}</b> points</li>`;
            });
        }
        leaderboardHTML += "</ol>";
        leaderboardContainer.innerHTML = leaderboardHTML;
    }, { onlyOnce: true });
}

// Open quiz UI and allow participant to take the quiz (if eligible)
function openQuizPanel(quizId) {
    if (!currentRoomId) return showToast('Join a room to take the quiz.', '#e11d48');
    quizContainer.classList.remove('hidden');

    const quizRef = ref(db, `rooms/${currentRoomId}/currentQuiz`);
    onValue(quizRef, async(snapshot) => {
        const quiz = snapshot.val();
        if (!quiz) return showToast('Quiz not found or already finished.', '#e11d48');

        const now = Date.now();
        if (now > quiz.endAt) return showToast('This quiz has ended.', '#e11d48');

        // Check if user already submitted
        const submissions = quiz.submissions || {};
        if (submissions[userId]) return showToast('You have already taken this quiz.', '#f59e0b');

        // Launch the interactive quiz
        runQuizForParticipant(quiz);
    }, { onlyOnce: true });
}

async function runQuizForParticipant(quiz) {
    quizContainer.innerHTML = '';
    const title = document.createElement('h3');
    title.innerText = `Quiz: ${quiz.quizName}`;
    quizContainer.appendChild(title);

    const qBox = document.createElement('div');
    quizContainer.appendChild(qBox);

    const answers = [];

    for (let i = 0; i < quiz.questions.length; i++) {
        const q = quiz.questions[i];
        qBox.innerHTML = '';
        const qTitle = document.createElement('div');
        qTitle.innerHTML = `<b>Q${i+1}.</b> ${q.question}`;
        qBox.appendChild(qTitle);

        const optsDiv = document.createElement('div');
        q.options.forEach((opt, idx) => {
            const letter = ['A', 'B', 'C', 'D'][idx];
            const btn = document.createElement('button');
            btn.className = 'btn';
            btn.style.display = 'block';
            btn.style.margin = '6px 0';
            btn.innerText = `${letter}. ${opt}`;
            btn.addEventListener('click', () => {
                if (optsDiv.dataset.answered) return;
                optsDiv.dataset.answered = '1';
                answers[i] = letter;
                // visual feedback
                btn.style.background = '#60a5fa';
                // proceed to next question
            });
            optsDiv.appendChild(btn);
        });
        qBox.appendChild(optsDiv);

        // per-question timer
        const perTime = (quiz.perQuestionTime || 30) * 1000;
        const start = Date.now();
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                // move to next when answered or time elapsed
                if (optsDiv.dataset.answered || Date.now() - start >= perTime) {
                    clearInterval(interval);
                    resolve();
                }
            }, 250);
        });
    }

    // compute score
    let score = 0;
    for (let i = 0; i < quiz.questions.length; i++) {
        const correct = (quiz.questions[i].answer || '').toUpperCase();
        if (answers[i] && answers[i].toUpperCase() === correct) score += 1;
    }

    // Save submission under currentQuiz/submissions and record per-quiz result
    const submission = { username, answers, score, timestamp: Date.now() };
    await set(ref(db, `rooms/${currentRoomId}/currentQuiz/submissions/${userId}`), submission);
    await set(ref(db, `rooms/${currentRoomId}/quizResults/${quiz.startedAt}/${userId}`), { username, score, timestamp: Date.now() });

    // Show results and leaderboard in the quizContainer
    quizContainer.innerHTML = `<h3>Your Score: ${score} / ${quiz.questions.length}</h3>`;
    const showAnswersBtn = document.createElement('button');
    showAnswersBtn.className = 'btn';
    showAnswersBtn.innerText = 'Show answers';
    quizContainer.appendChild(showAnswersBtn);

    const answersDiv = document.createElement('div');
    answersDiv.style.marginTop = '12px';
    showAnswersBtn.addEventListener('click', () => {
        answersDiv.innerHTML = '';
        quiz.questions.forEach((q, idx) => {
            const correct = q.answer || '';
            const el = document.createElement('div');
            el.innerHTML = `<b>Q${idx+1}.</b> ${q.question}<br><i>Correct:</i> ${correct} — ${q.options[['A','B','C','D'].indexOf(correct)] || ''}`;
            answersDiv.appendChild(el);
        });
    });
    quizContainer.appendChild(answersDiv);

    // show leaderboard below
    const lb = document.createElement('div');
    lb.style.marginTop = '16px';
    quizContainer.appendChild(lb);
    // reuse loadLeaderboard but render into lb: fetch aggregated results
    const leaderboardRef = ref(db, `rooms/${currentRoomId}/quizResults`);
    onValue(leaderboardRef, (snapshot) => {
        const all = snapshot.val() || {};
        const agg = {};
        Object.keys(all).forEach(quizId => {
            const perQuiz = all[quizId] || {};
            Object.keys(perQuiz).forEach(uid => {
                const entry = perQuiz[uid];
                if (!agg[uid]) agg[uid] = { username: entry.username || uid, score: 0 };
                agg[uid].score += Number(entry.score || 0);
            });
        });
        const sorted = Object.values(agg).sort((a, b) => b.score - a.score);
        let html = '<h4>Leaderboard</h4><ol>';
        sorted.forEach(s => html += `<li>${s.username}: <b>${s.score}</b></li>`);
        html += '</ol>';
        lb.innerHTML = html;
    }, { onlyOnce: true });
}


// Watch the currentQuiz node and auto-finalize when endAt passes.
function watchCurrentQuiz() {
    if (!currentRoomId) return;
    const quizRef = ref(db, `rooms/${currentRoomId}/currentQuiz`);

    // unsubscribe previous watcher if any
    if (currentQuizWatcherUnsub) {
        try { currentQuizWatcherUnsub(); } catch (e) {}
        currentQuizWatcherUnsub = null;
    }

    const onChange = (snapshot) => {
        const quiz = snapshot.val();
        if (!quiz) return;
        // If already finalized, nothing to do
        if (quiz.finished) return;

        const now = Date.now();
        const endAt = Number(quiz.endAt || 0);
        if (endAt && now >= endAt) {
            // finalize immediately
            finalizeQuiz(quiz).catch(err => console.error('finalizeQuiz error', err));
        } else if (endAt) {
            // schedule a finalization timeout
            const delay = Math.max(0, endAt - now + 500);
            setTimeout(() => finalizeQuiz(quiz).catch(err => console.error('finalizeQuiz error', err)), delay);
        }
    };

    // Listen for changes once (keeps it simple); also run initial check
    onValue(quizRef, onChange);
    // store an unsub wrapper so we could clear if needed
    currentQuizWatcherUnsub = () => { /* onValue doesn't return unsub in this usage; left as no-op */ };
}

async function finalizeQuiz(quiz) {
    if (!currentRoomId || !quiz || !quiz.startedAt) return;
    const quizId = String(quiz.startedAt);
    // Read per-user submissions from quizResults or currentQuiz/submissions
    const resultsRef = ref(db, `rooms/${currentRoomId}/quizResults/${quizId}`);
    // fetch once
    onValue(resultsRef, (snapshot) => {
        const perQuiz = snapshot.val() || {};
        // Build leaderboard array
        const board = Object.keys(perQuiz).map(uid => ({ uid, username: perQuiz[uid].username || uid, score: Number(perQuiz[uid].score || 0) }));
        board.sort((a, b) => b.score - a.score);

        // write leaderboard summary under rooms/<roomId>/leaderboards/<quizId>
        set(ref(db, `rooms/${currentRoomId}/leaderboards/${quizId}`), { leaderboard: board, finalizedAt: Date.now() })
            .then(() => {
                // mark quiz finished
                set(ref(db, `rooms/${currentRoomId}/currentQuiz/finished`), true);
                // push a message announcing final results
                push(ref(db, `rooms/${currentRoomId}/messages`), {
                    sender: AI_USER_ID,
                    username: '🤖 AI Partner',
                    text: `Quiz "${quiz.quizName}" has ended. Final leaderboard is available.`,
                    timestamp: Date.now()
                });
            })
            .catch(err => console.error('Error writing leaderboard', err));
    }, { onlyOnce: true });
}

// --- SEND BUTTON & INPUT HANDLERS ---
if (sendBtn) {
    // Click send
    sendBtn.addEventListener('click', async() => {
        // --- 0. CAPTURE & CLEAR INPUTS EARLY (FIX FOR REMAINING TEXT) ---
        // Capture the text content first
        const text = (chatInput && chatInput.value) ? chatInput.value.trim() : '';
        // Get the file element and declare it globally for this scope
        const fileEl = document.getElementById('fileInput');

        // CLEAR TEXT INPUT IMMEDIATELY (Fixes the problem of text remaining)
        if (chatInput) chatInput.value = '';
        // -----------------------------------------------------------------

        // If AI tab is selected, send to the AI backend; otherwise send as group message
        if (aiTab && aiTab.classList.contains('selected')) {

            if (!currentRoomId) return showToast('Join a room to use the AI partner.', '#e11d48');
            // Check if both text and file are empty (text has been read before clearing)
            if (!text && (!fileEl || !fileEl.files || fileEl.files.length === 0)) {
                // The input is already cleared, just show the error and exit
                return showToast('Type a message or select a file first.', '#e11d48');
            }

            // --- 1. PREPARE FILE AND USER MESSAGE ---
            let filePayload = null;
            let fileDataUrl = null;
            let fileType = null;
            let fileName = null;

            try {
                if (fileEl && fileEl.files && fileEl.files.length > 0) {
                    const f = fileEl.files[0];
                    fileDataUrl = await readFileAsDataURL(f); // Full Data URL for local display
                    filePayload = { data: cleanDataURL(fileDataUrl), mimeType: f.type }; // Payload for backend
                    fileType = f.type;
                    fileName = f.name;
                }
            } catch (e) {
                console.warn('Failed to read attached file for AI send:', e);
                showToast('Failed to read attached file.', '#e11d48');
            }

            // Create user message object, now conditionally including file details
            const userMsg = {
                sender: userId,
                username,
                text,
                timestamp: Date.now(),
                // Includes file data for display
                ...(fileDataUrl && {
                    fileData: fileDataUrl,
                    fileType: fileType,
                    fileName: fileName
                })
            };

            // 2. SHOW AND PUSH USER MESSAGE
            await push(ref(db, `rooms/${currentRoomId}/messages`), userMsg);
            // try { displayMessage(aiChatBox, userMsg); } catch (e) {} // <-- REMOVED: Listener handles display (FIX)


            // --- 3. ADD THINKING INDICATOR ---
            const thinkingMsgEl = document.createElement("div");
            thinkingMsgEl.className = "msg ai thinking";
            thinkingMsgEl.innerHTML = '<b>🤖 AI Partner:</b> _thinking..._';
            aiChatBox.appendChild(thinkingMsgEl);
            aiChatBox.scrollTop = aiChatBox.scrollHeight;


            let aiText = '';
            try {
                // 4. CALL AI BACKEND
                aiText = await sendQueryToGemini(text, filePayload);
            } catch (error) {
                // If all retries fail, generate a user-friendly failure message
                aiText = `❌ AI Service unavailable after retries. (${error.message || 'Network Error'}). Please try again in a moment.`;
            } finally {
                // 5. REMOVE THINKING INDICATOR
                if (thinkingMsgEl.parentNode) {
                    thinkingMsgEl.parentNode.removeChild(thinkingMsgEl);
                }
            }


            // 6. PUSH AND DISPLAY AI RESPONSE
            const aiMsg = { sender: AI_USER_ID, username: '🤖 AI Partner', text: aiText, timestamp: Date.now() };
            await push(ref(db, `rooms/${currentRoomId}/messages`), aiMsg);
            // try { displayMessage(aiChatBox, aiMsg); } catch (e) {} // <-- REMOVED: Listener handles display (FIX)

            // clear file input after sending
            try { if (fileEl) fileEl.value = ''; } catch (e) {}

        } else {
            // Group chat send
            if (!currentRoomId) return showToast('Join a room to send messages.', '#e11d48');
            // 'text' is already captured and chatInput is already cleared. Check if text is present.
            if (!text) return showToast('Type a message first.', '#e11d48');

            await push(ref(db, `rooms/${currentRoomId}/messages`), {
                sender: userId,
                username,
                text,
                timestamp: Date.now()
            });
            // No need to clear chatInput here, as it was cleared at the top of the function
        }
    });

    // Enter key submits
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendBtn.click();
            }
        });
    }
}

// --- Mount-aware API prefix detection ---
const KNOWN_PREFIXES = ['/chat', '/study', '/quiz'];
let API_PREFIX = '';
try {
    const p = (window.location && window.location.pathname) ? window.location.pathname : '';
    API_PREFIX = KNOWN_PREFIXES.find(pref => p === pref || p.startsWith(pref + '/')) || '';
} catch (e) {
    API_PREFIX = '';
}

function _makePath(path) {
    path = (path || '').replace(/^\/+/, '');
    const mount = (API_PREFIX && API_PREFIX.length) ? API_PREFIX : '/study';
    return mount.replace(/\/$/, '') + '/' + path;
}

async function apiFetch(path, options) {
    const rel = _makePath(path);
    try {
        console.debug('apiFetch trying (relative):', rel);
        const r = await fetch(rel, options);
        if (r && r.ok) return r;
    } catch (e) {
        console.debug('apiFetch relative failed', e);
    }

    const origin = window.origin || 'http://127.0.0.1:5000';
    const candidates = [
        origin + rel,
        origin + '/study/' + path.replace(/^\/+/, ''),
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
    return fetch(origin + rel, options);
}