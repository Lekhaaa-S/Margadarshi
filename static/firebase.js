//define firebase and its services
// Firebase v10+ (compat SDKs for non-module usage)

const firebaseConfig = {
  apiKey: "AIzaSyCsdv2DcDa_u-kNBAXuq3TXp9nfdLy-chs",
  authDomain: "margadarshi-85118.firebaseapp.com",
  databaseURL: "https://margadarshi-85118-default-rtdb.firebaseio.com",
  projectId: "margadarshi-85118",
  storageBucket: "margadarshi-85118.firebasestorage.app",
  messagingSenderId: "868205365403",
  appId: "1:868205365403:web:2f2abcc026c0a88968de3e"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Make Firestore/Auth/Storage available globally
window.db = firebase.firestore();
window.auth = firebase.auth();

// Note: automatic anonymous sign-in has been removed. The app requires users to
// sign in through the normal login flow before accessing progress. If you want
// anonymous users supported, enable Anonymous sign-in in the Firebase Console
// and re-enable signInAnonymously() here.

// Note: For modular SDK usage (ESM), use the following imports instead:
/*
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
*/

// Provide a global logout helper that pages can safely call.
// Behavior: try Firebase signOut (if configured), call server /logout to end session (best-effort),
// clear local/session storage, and redirect to the public home page.
if (typeof window.logout !== 'function') {
  window.logout = async function() {
    try {
      if (window.auth && typeof window.auth.signOut === 'function') {
        await window.auth.signOut();
      }
    } catch (e) {
      console.warn('Firebase signOut failed', e);
    }
    // Try to hit server-side logout endpoint (best-effort). Some deployments expect GET; some POST.
    try {
      await fetch('/logout', { method: 'GET', credentials: 'include' });
    } catch (e) {
      // ignore network errors — we still proceed to clear local state
    }
    try { localStorage.removeItem('user'); } catch (e) {}
    try { sessionStorage.removeItem('user'); } catch (e) {}
    // Redirect to public/home page
    try { window.location.href = 'home.html'; } catch (e) { /* ignore */ }
  };
}
