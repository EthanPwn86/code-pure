import { Env } from "./types";
import { WORD_BANK } from "./wordBank";
import { FALLBACK_WORDS } from "./fallbackWords";

const SELECT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const CYCLE = [2, 3, 1, 2] as const;

type Body = {
  secret?: string;
  context?: string;
  tone?: string;
  visibleInfo?: string;
  relation?: string;
};

type Constraint = {
  position: number;
  letter: string;
  group: number;
};

type Candidate = {
  id: string;
  word: string;
  type?: string;
};

function normalizeSecret(input: string): string {
  return input
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function reversePairs(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 2) {
    out += i + 1 < value.length ? value[i + 1] + value[i] : value[i];
  }
  return out;
}

function cleanWord(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function prepare(secret: string) {
  const encodedGroups = secret.split(" ").filter(Boolean).map(reversePairs);
  const constraints: Constraint[] = [];
  let wordIndex = 0;

  encodedGroups.forEach((group, groupIndex) => {
    for (const letter of group) {
      constraints.push({
        position: CYCLE[wordIndex % CYCLE.length],
        letter,
        group: groupIndex,
      });
      wordIndex++;
    }
  });

  return { encodedGroups, constraints };
}

function matches(word: string, constraint: Constraint) {
  const cleaned = cleanWord(word);
  return (
    cleaned.length >= constraint.position &&
    cleaned[constraint.position - 1] === constraint.letter
  );
}

function candidatePool(constraint: Constraint, slotIndex: number): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];

  const add = (word: string, type?: string) => {
    const key = cleanWord(word);
    if (!key || seen.has(key)) return;
    if (!matches(word, constraint)) return;
    if (word.length > 16 || word.length < 2) return;
    seen.add(key);
    out.push({
      id: "S" + (slotIndex + 1) + "_" + (out.length + 1),
      word,
      type,
    });
  };

  for (const entry of WORD_BANK) {
    if (out.length >= 18) break;
    if (entry.word.includes(" ")) continue;
    add(entry.word, entry.type);
  }

  const fallbackMatches = FALLBACK_WORDS.filter((word) => {
    if (!matches(word, constraint)) return false;
    if (word.length > 16 || word.length < 2) return false;
    if (/^[A-ZÀ-Ý]/.test(word)) return false;
    return !seen.has(cleanWord(word));
  });

  const target = 34;
  const needed = Math.max(0, target - out.length);

  if (needed > 0 && fallbackMatches.length > 0) {
    if (fallbackMatches.length <= needed) {
      for (const word of fallbackMatches) add(word);
    } else {
      for (let i = 0; i < needed; i++) {
        const index =
          needed === 1
            ? Math.floor(fallbackMatches.length / 2)
            : Math.floor(
                (i * (fallbackMatches.length - 1)) / (needed - 1),
              );
        add(fallbackMatches[index]);
      }
    }
  }

  return out;
}

function buildZone(words: string[], encodedGroups: string[]) {
  const groups: string[] = [];
  let offset = 0;

  for (const group of encodedGroups) {
    groups.push(words.slice(offset, offset + group.length).join(" "));
    offset += group.length;
  }

  return groups.join(", ");
}

function decodeZone(zone: string) {
  const groups = zone.split(",");
  let wordIndex = 0;
  const rawGroups: string[] = [];

  for (const group of groups) {
    let raw = "";
    for (const token of group.trim().split(/\s+/).filter(Boolean)) {
      const cleaned = cleanWord(token);
      const position = CYCLE[wordIndex % CYCLE.length];
      if (cleaned.length < position) throw new Error("Mot trop court.");
      raw += cleaned[position - 1];
      wordIndex++;
    }
    rawGroups.push(raw);
  }

  return {
    rawGroups,
    message: rawGroups.map(reversePairs).join(" "),
  };
}

function extractJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Réponse IA non structurée.");
  }
  return JSON.parse(text.slice(start, end + 1)) as {
    choices?: string[];
    before?: string;
    after?: string;
  };
}

async function askSelector(env: Env, prompt: string) {
  const result = (await env.AI.run(SELECT_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "Tu choisis des mots dans des listes imposées afin de former une phrase française naturelle. Tu réponds uniquement en JSON valide, sans markdown.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 520,
    temperature: 0.35,
  })) as unknown as { response?: string };

  return typeof result?.response === "string" ? result.response.trim() : "";
}

function sanitizeOuterText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.replace(/[()]/g, "").trim();
}

async function chooseSentence(
  env: Env,
  body: Body,
  encodedGroups: string[],
  pools: Candidate[][],
) {
  const boundaries: number[] = [];
  let running = 0;
  for (let i = 0; i < encodedGroups.length - 1; i++) {
    running += encodedGroups[i].length;
    boundaries.push(running);
  }

  const listText = pools
    .map((pool, index) => {
      const rendered = pool
        .map((candidate) => {
          const type = candidate.type ? ":" + candidate.type : "";
          return candidate.id + "=" + candidate.word + type;
        })
        .join(" | ");
      return "EMPLACEMENT " + (index + 1) + " -> " + rendered;
    })
    .join("\n");

  const basePrompt =
    "Tu dois construire un fragment de phrase française naturel en choisissant EXACTEMENT un identifiant par emplacement.\n\n" +
    "Contexte de la lettre : " + (body.context || "libre") + "\n" +
    "Ton : " + (body.tone || "naturel") + "\n" +
    "Destinataire : " + (body.relation || "non précisé") + "\n" +
    "Informations visibles : " + (body.visibleInfo || "aucune") + "\n\n" +
    "Le fragment aura " + pools.length + " mots.\n" +
    "Des virgules seront ajoutées automatiquement après les mots " +
    (boundaries.length ? boundaries.join(", ") : "aucun") +
    ". Le fragment doit rester naturel avec ces virgules.\n" +
    "Tu dois uniquement choisir dans les listes. Tu ne peux inventer aucun mot.\n" +
    "Les mentions après ':' indiquent parfois la catégorie grammaticale et servent seulement à t'aider.\n\n" +
    listText +
    "\n\n" +
    "Réponds UNIQUEMENT avec ce JSON exact :\n" +
    '{"choices":["S1_x","S2_x", "..."],"before":"texte de la lettre juste avant le fragment","after":"texte de la lettre juste après le fragment"}\n' +
    "Règles du JSON :\n" +
    "- choices contient exactement " + pools.length + " identifiants, un par emplacement, dans l'ordre.\n" +
    "- before et after rendent la lettre crédible et naturelle dans le contexte.\n" +
    "- before et after ne contiennent aucune parenthèse.\n" +
    "- Le fragment choisi doit avoir un vrai sens en français, pas seulement respecter les listes.";

  let feedback = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await askSelector(
      env,
      basePrompt +
        (feedback
          ? "\n\nTa réponse précédente était invalide : " +
            feedback +
            "\nCorrige uniquement ce qui est nécessaire."
          : ""),
    );

    try {
      const parsed = extractJson(raw);
      if (!Array.isArray(parsed.choices)) {
        feedback = "Le champ choices manque.";
        continue;
      }
      if (parsed.choices.length !== pools.length) {
        feedback =
          "choices doit contenir exactement " +
          pools.length +
          " identifiants.";
        continue;
      }

      const words: string[] = [];
      let invalid = "";

      for (let i = 0; i < pools.length; i++) {
        const id = String(parsed.choices[i] || "");
        const candidate = pools[i].find((item) => item.id === id);
        if (!candidate) {
          invalid =
            "L'identifiant " +
            id +
            " n'appartient pas à l'emplacement " +
            (i + 1) +
            ".";
          break;
        }
        words.push(candidate.word);
      }

      if (invalid) {
        feedback = invalid;
        continue;
      }

      return {
        words,
        before: sanitizeOuterText(parsed.before),
        after: sanitizeOuterText(parsed.after),
      };
    } catch (error) {
      feedback =
        error instanceof Error ? error.message : "JSON invalide.";
    }
  }

  throw new Error("L'IA n'a pas réussi à choisir une combinaison valide.");
}

function assembleLetter(before: string, zone: string, after: string) {
  const cleanBefore = before.trim();
  const cleanAfter = after.trim();

  if (!cleanBefore && !cleanAfter) {
    return "Bonjour,\n\n(" + zone + ")\n\nBien à vous.";
  }

  const left = cleanBefore
    ? cleanBefore + (/\s$/.test(before) ? "" : " ")
    : "";
  const right = cleanAfter
    ? (/^[.,;:!?]/.test(cleanAfter) ? "" : " ") + cleanAfter
    : "";

  return left + "(" + zone + ")" + right;
}

async function handleGenerate(request: Request, env: Env) {
  const body = (await request.json()) as Body;
  const secret = normalizeSecret(body.secret || "");

  if (!secret) {
    return Response.json(
      { error: "Le message secret est vide." },
      { status: 400 },
    );
  }

  if (secret.length > 80) {
    return Response.json(
      {
        error:
          "Le message secret est trop long. Utilise des abréviations courtes.",
      },
      { status: 400 },
    );
  }

  const { encodedGroups, constraints } = prepare(secret);
  const pools = constraints.map((constraint, index) =>
    candidatePool(constraint, index),
  );

  const missing = pools.findIndex((pool) => pool.length === 0);
  if (missing !== -1) {
    const c = constraints[missing];
    return Response.json(
      {
        error:
          "Aucun mot disponible pour la contrainte " +
          (missing + 1) +
          " (" +
          c.position +
          "e lettre = " +
          c.letter +
          ").",
      },
      { status: 422 },
    );
  }

  try {
    const selection = await chooseSentence(
      env,
      body,
      encodedGroups,
      pools,
    );

    const zone = buildZone(selection.words, encodedGroups);
    const decoded = decodeZone(zone);

    if (decoded.message !== secret) {
      throw new Error("La vérification finale du code a échoué.");
    }

    const text = assembleLetter(
      selection.before,
      zone,
      selection.after,
    );

    return Response.json({
      ok: true,
      text,
      decoded: decoded.message,
      extraction: decoded.rawGroups,
      attempts: 1,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "La génération n'a pas abouti.",
      },
      { status: 422 },
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/generate") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      try {
        return await handleGenerate(request, env);
      } catch (error) {
        console.error(error);
        return Response.json(
          { error: "Erreur pendant la génération." },
          { status: 500 },
        );
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
