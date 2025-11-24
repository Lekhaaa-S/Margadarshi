// index.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const path = require("path");

// Init Firebase Admin
const serviceAccount = require(path.join(__dirname, "serviceAccountKey.json"));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(cors());            // allow frontend fetches from file:// or other origin
app.use(express.json());    // parse JSON body


// ---------- Signup endpoint ----------
// Expects JSON: { name, email, password }
app.post("/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, message: "Missing fields" });

    // 1) create Firebase Auth user
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: name
    });

    const uid = userRecord.uid;

    // 2) create Firestore profile document
    await db.collection("users").doc(uid).set({
      name,
      email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ success: true, message: "User created", uid });
  } catch (err) {
    console.error("Signup error:", err);
    // common failures: email already exists etc.
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- Get user profile ----------
// GET /user/:uid  (useful after client signs-in to fetch profile)
app.get("/user/:uid", async (req, res) => {
  try {
    const uid = req.params.uid;
    const doc = await db.collection("users").doc(uid).get();
    if (!doc.exists) return res.status(404).json({ success: false, message: "User not found" });
    return res.json({ success: true, user: doc.data() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Optional: health route
app.get("/", (req, res) => res.send("Backend running"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
