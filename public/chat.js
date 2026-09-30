const CYCLE = [2, 3, 1, 2];

const tabs = document.querySelectorAll(".tab");
const panels = {
  encoder: document.getElementById("encoder"),
  decoder: document.getElementById("decoder"),
};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    Object.values(panels).forEach((p) => p.classList.add("hidden"));
    tab.classList.add("active");
    panels[tab.dataset.tab].classList.remove("hidden");
  });
});

function normalizeSecret(input) {
  return input
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function reversePairs(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 2) {
    out += i + 1 < value.length ? value[i + 1] + value[i] : value[i];
  }
  return out;
}

function lettersOnly(token) {
  return token
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function decodeText(text) {
  const match = text.match(/\(([\s\S]*?)\)/);
  if (!match) throw new Error("Aucune zone codée trouvée entre parenthèses.");

  const zone = match[1].trim();
  const groups = zone.split(",");
  const rawGroups = [];
  let globalWordIndex = 0;

  for (const group of groups) {
    const tokens = group.trim().split(/\s+/).filter(Boolean);
    let raw = "";

    for (const token of tokens) {
      const word = lettersOnly(token);
      if (!word) continue;

      const position = CYCLE[globalWordIndex % CYCLE.length];
      if (word.length < position) {
        throw new Error('Mot trop court : "' + token + '" pour la position ' + position + ".");
      }

      raw += word[position - 1];
      globalWordIndex++;
    }

    rawGroups.push(raw);
  }

  return {
    zone,
    rawGroups,
    message: rawGroups.map(reversePairs).join(" "),
  };
}

const generateBtn = document.getElementById("generateBtn");
const regenerateBtn = document.getElementById("regenerateBtn");
const statusBox = document.getElementById("generationStatus");
const resultBox = document.getElementById("generationResult");
const resultText = document.getElementById("resultText");
const resultMeta = document.getElementById("resultMeta");
const copyBtn = document.getElementById("copyBtn");

async function generate() {
  const secret = normalizeSecret(document.getElementById("secret").value);
  if (!secret) {
    statusBox.classList.remove("hidden");
    statusBox.innerHTML = '<span class="bad">Entre un message secret.</span>';
    return;
  }

  const payload = {
    secret,
    context: document.getElementById("context").value.trim(),
    tone: document.getElementById("tone").value,
    visibleInfo: document.getElementById("visibleInfo").value.trim(),
    relation: document.getElementById("relation").value.trim(),
  };

  generateBtn.disabled = true;
  regenerateBtn.disabled = true;
  resultBox.classList.add("hidden");
  statusBox.classList.remove("hidden");
  statusBox.textContent = "Génération en cours… Le texte est vérifié automatiquement avant affichage.";

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "La génération a échoué.");
    }

    resultText.textContent = data.text;
    resultMeta.innerHTML =
      '<span class="ok">✓ Vérifié automatiquement : ' +
      data.decoded +
      "</span> · " +
      data.attempts +
      " tentative(s)";
    resultBox.classList.remove("hidden");
    regenerateBtn.classList.remove("hidden");
    statusBox.classList.add("hidden");
  } catch (error) {
    statusBox.innerHTML =
      '<span class="bad">✗ ' +
      (error?.message || "Erreur inconnue.") +
      "</span>";
    regenerateBtn.classList.remove("hidden");
  } finally {
    generateBtn.disabled = false;
    regenerateBtn.disabled = false;
  }
}

generateBtn.addEventListener("click", generate);
regenerateBtn.addEventListener("click", generate);

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(resultText.textContent || "");
  const old = copyBtn.textContent;
  copyBtn.textContent = "COPIÉ ✓";
  setTimeout(() => (copyBtn.textContent = old), 1200);
});

document.getElementById("decodeBtn").addEventListener("click", () => {
  const box = document.getElementById("decodeResult");
  box.classList.remove("hidden");

  try {
    const decoded = decodeText(document.getElementById("decodeInput").value);
    box.innerHTML =
      '<span class="ok">✓ MESSAGE DÉCODÉ</span>\n\n' +
      decoded.message +
      "\n\nExtraction : " +
      decoded.rawGroups.join(", ");
  } catch (error) {
    box.innerHTML =
      '<span class="bad">✗ ' +
      (error?.message || "Décodage impossible.") +
      "</span>";
  }
});
