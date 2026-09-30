import { Env } from "./types";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
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

function parseZone(zone: string) {
  const groups = zone.split(",");
  const groupWords = groups.map((group) =>
    group.trim().split(/\s+/).filter(Boolean),
  );
  return { groups, groupWords, words: groupWords.flat() };
}

function validWord(word: string, constraint: Constraint) {
  if (/['’\-]/.test(word)) return false;
  const cleaned = cleanWord(word);
  return (
    cleaned.length >= constraint.position &&
    cleaned[constraint.position - 1] === constraint.letter
  );
}

function validateStructure(zone: string, groupSizes: number[]) {
  const { groupWords, words } = parseZone(zone);
  if (groupWords.length !== groupSizes.length) return false;
  for (let i = 0; i < groupSizes.length; i++) {
    if ((groupWords[i]?.length ?? 0) !== groupSizes[i]) return false;
  }
  return words.length === groupSizes.reduce((a, b) => a + b, 0);
}

function decodeZone(zone: string) {
  const { groupWords } = parseZone(zone);
  let wordIndex = 0;
  const rawGroups: string[] = [];

  for (const words of groupWords) {
    let raw = "";
    for (const token of words) {
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

function replaceWord(zone: string, targetIndex: number, replacement: string) {
  const { groupWords } = parseZone(zone);
  let index = 0;

  for (let g = 0; g < groupWords.length; g++) {
    for (let w = 0; w < groupWords[g].length; w++) {
      if (index === targetIndex) {
        groupWords[g][w] = replacement;
        return groupWords.map((words) => words.join(" ")).join(", ");
      }
      index++;
    }
  }

  return zone;
}

function parseCandidates(text: string) {
  return Array.from(
    new Set(
      text
        .replace(/[\[\]{}"«»]/g, " ")
        .split(/[\n,;|]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .flatMap((x) => x.split(/\s+/))
        .map((x) =>
          x.replace(/^[^A-Za-zÀ-ÿ0-9]+|[^A-Za-zÀ-ÿ0-9]+$/g, ""),
        )
        .filter(Boolean),
    ),
  );
}

async function ask(
  env: Env,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens = 220,
  temperature = 0.55,
) {
  const result = (await env.AI.run(MODEL, {
    messages,
    max_tokens: maxTokens,
    temperature,
  })) as unknown as { response?: string };

  return typeof result?.response === "string" ? result.response.trim() : "";
}

async function makeBaseZone(
  env: Env,
  body: Body,
  groupSizes: number[],
) {
  const total = groupSizes.reduce((a, b) => a + b, 0);
  const structure = groupSizes
    .map((size, i) => "groupe " + (i + 1) + " = " + size + " mots")
    .join(", ");

  for (let attempt = 0; attempt < 5; attempt++) {
    const prompt =
      "Écris une seule proposition française naturelle et crédible de exactement " +
      total +
      " mots.\n" +
      "Contexte : " + (body.context || "libre") + "\n" +
      "Ton : " + (body.tone || "naturel") + "\n" +
      "Destinataire : " + (body.relation || "non précisé") + "\n" +
      "Structure obligatoire : " + structure + ".\n" +
      "Sépare les groupes uniquement avec une virgule suivie d'un espace.\n" +
      "Aucune autre ponctuation. Pas d'apostrophe ni de mot composé.\n" +
      "Le résultat doit avoir un vrai sens, comme un fragment normal de lettre.\n" +
      "Réponds uniquement avec la proposition.";

    const candidate = (await ask(
      env,
      [
        {
          role: "system",
          content:
            "Tu écris des phrases françaises naturelles en respectant exactement un nombre de mots et des virgules imposées.",
        },
        { role: "user", content: prompt },
      ],
      180,
      0.75,
    ))
      .replace(/^["'«]+|["'»]+$/g, "")
      .replace(/^\(|\)$/g, "")
      .replace(/[.!?]+$/g, "")
      .trim();

    if (validateStructure(candidate, groupSizes)) return candidate;
  }

  throw new Error("Impossible de créer la phrase de base.");
}

async function findReplacement(
  env: Env,
  body: Body,
  zone: string,
  wordIndex: number,
  currentWord: string,
  constraint: Constraint,
) {
  const prompt =
    "Phrase actuelle : " + zone + "\n\n" +
    "Remplace UNIQUEMENT le mot numéro " + (wordIndex + 1) +
    ' "' + currentWord + '" par un autre mot français.\n' +
    "Le remplacement doit garder la phrase naturelle et conserver au mieux le même rôle grammatical, genre, nombre ou temps.\n" +
    "Contrainte absolue : la " + constraint.position +
    "e lettre du nouveau mot doit être exactement " + constraint.letter + ".\n" +
    "Pas d'apostrophe. Pas de tiret. Un seul mot.\n" +
    "Contexte général : " + (body.context || "libre") + "\n" +
    "Propose 12 remplacements possibles, du plus naturel au moins naturel, séparés uniquement par des virgules.";

  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await ask(
      env,
      [
        {
          role: "system",
          content:
            "Tu proposes des remplacements d'un seul mot dans une phrase française. Chaque proposition doit respecter exactement la position de lettre demandée.",
        },
        { role: "user", content: prompt },
      ],
      130,
      0.75 + attempt * 0.08,
    );

    const candidates = parseCandidates(text).filter((word) =>
      validWord(word, constraint),
    );

    if (candidates.length > 0) return candidates[0];
  }

  throw new Error(
    "Impossible de corriger le mot " +
      (wordIndex + 1) +
      " (" +
      constraint.position +
      "e lettre = " +
      constraint.letter +
      ").",
  );
}

async function repairZone(
  env: Env,
  body: Body,
  baseZone: string,
  constraints: Constraint[],
  groupSizes: number[],
) {
  let zone = baseZone;

  for (let i = 0; i < constraints.length; i++) {
    const parsed = parseZone(zone);
    const currentWord = parsed.words[i];

    if (!currentWord) throw new Error("Structure de phrase invalide.");

    if (validWord(currentWord, constraints[i])) continue;

    const replacement = await findReplacement(
      env,
      body,
      zone,
      i,
      currentWord,
      constraints[i],
    );

    zone = replaceWord(zone, i, replacement);

    if (!validateStructure(zone, groupSizes)) {
      throw new Error("La correction a cassé la structure du message.");
    }
  }

  return zone;
}

async function judgeNaturalness(env: Env, body: Body, zone: string) {
  const prompt =
    "Évalue uniquement si cette proposition paraît naturelle et compréhensible en français dans le contexte donné.\n" +
    "Contexte : " + (body.context || "libre") + "\n" +
    "Proposition : " + zone + "\n" +
    "Réponds uniquement NATURAl si elle pourrait apparaître dans une vraie lettre, sinon BIZARRE.";

  const verdict = await ask(
    env,
    [
      {
        role: "system",
        content:
          "Tu es un relecteur de français. Tu réponds uniquement NATUREL ou BIZARRE.",
      },
      { role: "user", content: prompt },
    ],
    12,
    0.1,
  );

  return verdict.toUpperCase().includes("NATUREL");
}

async function wrapLetter(env: Env, body: Body, zone: string) {
  const marker = "[[ZONE_CODEE]]";

  const prompt =
    "Écris une petite lettre française naturelle et crédible.\n" +
    "Contexte : " + (body.context || "libre") + "\n" +
    "Ton : " + (body.tone || "naturel") + "\n" +
    "Destinataire : " + (body.relation || "non précisé") + "\n" +
    "Informations visibles à intégrer : " + (body.visibleInfo || "aucune") + "\n\n" +
    "La proposition qui sera insérée à la place du marqueur est : " + zone + "\n" +
    "Place exactement une fois le marqueur " + marker + " à l'endroit où cette proposition s'intègre naturellement.\n" +
    "N'écris PAS toi-même la proposition dans la lettre, utilise seulement le marqueur.\n" +
    "Réponds uniquement avec la lettre finale.";

  for (let attempt = 0; attempt < 3; attempt++) {
    const draft = await ask(
      env,
      [
        {
          role: "system",
          content:
            "Tu rédiges des lettres françaises courtes et naturelles en plaçant exactement un marqueur imposé.",
        },
        { role: "user", content: prompt },
      ],
      360,
      0.65,
    );

    if (draft.includes(marker)) {
      return draft.replace(marker, "(" + zone + ")");
    }
  }

  return "Bonjour,\n\n(" + zone + ")\n\nBien à vous.";
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
  const groupSizes = encodedGroups.map((group) => group.length);

  let lastError = "";

  for (let restart = 0; restart < 3; restart++) {
    try {
      const base = await makeBaseZone(env, body, groupSizes);
      const zone = await repairZone(
        env,
        body,
        base,
        constraints,
        groupSizes,
      );

      const decoded = decodeZone(zone);

      if (decoded.message !== secret) {
        throw new Error(
          "La phrase corrigée ne redonne pas le message attendu.",
        );
      }

      const natural = await judgeNaturalness(env, body, zone);
      if (!natural && restart < 2) {
        lastError = "La phrase était valide mais trop artificielle.";
        continue;
      }

      const finalText = await wrapLetter(env, body, zone);
      const finalMatch = finalText.match(/\(([\s\S]*?)\)/);

      if (!finalMatch || finalMatch[1].trim() !== zone) {
        throw new Error("La zone codée a été modifiée pendant la rédaction.");
      }

      return Response.json({
        ok: true,
        text: finalText,
        decoded: decoded.message,
        extraction: decoded.rawGroups,
        attempts: restart + 1,
      });
    } catch (error) {
      lastError =
        error instanceof Error
          ? error.message
          : "La génération n'a pas abouti.";
    }
  }

  return Response.json(
    {
      ok: false,
      error:
        lastError ||
        "La génération n'a pas abouti. Clique sur Régénérer.",
    },
    { status: 422 },
  );
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
