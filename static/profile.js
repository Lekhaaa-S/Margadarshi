

const profileForm = document.getElementById("profileForm");
const subjectList = document.getElementById("subject-list");
const addBtn = document.getElementById("add-subject-btn");
const newSubjectInput = document.getElementById("new-subject");

// --- Logout Function ---
window.logout = async function () {
  try {
    await auth.signOut();
    alert("Logged out successfully!");
    window.location.href = "login.html";
  } catch (error) {
    console.error("Logout failed:", error);
  }
};

// --- Load Profile Data ---
auth.onAuthStateChanged(async (user) => {
  if (user) {
    const docRef = db.collection("users").doc(user.uid);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      const data = docSnap.data();

      document.getElementById("name").value = data.name || "";
      document.getElementById("examGoal").value = data.examGoal || "";
      document.getElementById("futureAim").value = data.futureAim || "";

      // Load hobbies (previously subjects)
      if (Array.isArray(data.hobbies)) {
        data.hobbies.forEach((hobby) => addSubjectToList(hobby));
      }
    }
  } else {
    window.location.href = "login.html";
  }
});

// --- Add Hobby Function ---
function addSubjectToList(hobby) {
  const item = document.createElement("div");
  item.className = "subject-item";

  const span = document.createElement("span");
  span.textContent = hobby;

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => item.remove());

  item.appendChild(span);
  item.appendChild(removeBtn);
  subjectList.appendChild(item);
}

// --- Add Button Click ---
addBtn.addEventListener("click", () => {
  const hobby = newSubjectInput.value.trim();
  if (hobby) {
    addSubjectToList(hobby);
    newSubjectInput.value = "";
    newSubjectInput.focus();
  }
});

// --- Allow Enter key ---
newSubjectInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addBtn.click();
  }
});

// --- Save Profile ---
profileForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return alert("⚠️ Not logged in");

  const name = document.getElementById("name").value.trim();
  const examGoal = document.getElementById("examGoal").value.trim();
  const futureAim = document.getElementById("futureAim").value.trim();

  const hobbies = [];
  subjectList.querySelectorAll(".subject-item span").forEach((span) => {
    hobbies.push(span.textContent);
  });

  try {
    await db.collection("users").doc(user.uid).set(
      { name, examGoal, futureAim, hobbies },
      { merge: true }
    );
    alert("✅ Profile saved successfully!");
  } catch (error) {
    console.error("Error saving profile:", error);
    alert("❌ Failed to save profile. Try again!");
  }
});
