function goLogin() {
  window.location.href = "login.html";
}

const quotes = [
  "“Every learner can become their own teacher.” ✨",
  "“Consistency beats intensity — keep learning daily.” 🚀",
  "“Ask, analyze, achieve — that’s progress.” 💪",
  "“Your study buddy is here — learn smarter, not harder.” 🧠"
];

document.getElementById("quoteBar").innerText = quotes[Math.floor(Math.random() * quotes.length)];
