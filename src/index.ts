import { Env } from "./types";

const MODEL = "@cf/meta/llama-3.2-3b-instruct";
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

function wordsOf(text: string) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function buildZoneFromWords(words: string[], groupSizes: number[]) {
  const groups: string[] = [];
  let offset = 0;

  for (const size of groupSizes) {
    groups.push(words.slice(offset, offset + size).join(" "));
    offset += size;
  }

  return groups.join(", ");
}

function parseZone(zone: string) {
  const groups = zone.split(",");
  const groupWords = groups.map((g) => wordsOf(g));
  return { groupWords, words: groupWords.flat() };
}

function validWord(word: string, constraint: Constraint) {
  const cleaned = cleanWord(word);
  return (
    cleaned.length >= constraint.position &&
    cleaned[constraint.position - 1] === constraint.letter
  );
}

function decodeZone(zone: string) {
  const { groupWords } = parseZone(zone);
  let wordIndex = 0;
  const rawGroups: string[] = [];

  for (const group of groupWords) {
    let raw = "";
    for (const token of group) {
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
          x.replace(/^[^A-Za-zÀ-ÿ0-9'’\-]+|[^A-Za-zÀ-ÿ0-9'’\-]+$/g, ""),
        )
        .filter(Boolean),
    ),
  );
}

async function ask(
  env: Env,
  prompt: string,
  maxTokens = 180,
  temperature = 0.55,
) {
  const result = (await env.AI.run(MODEL, {
    messages: [
      {
        role: "system",
        content:
          "Tu es un rédacteur français rigoureux. Suis exactement les contraintes demandées et réponds sans explication.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: maxTokens,
    temperature,
  })) as unknown as { response?: string };

  return typeof result?.response === "string" ? result.response.trim() : "";
}

async function makeBaseWords(
  env: Env,
  body: Body,
  total: number,
  groupSizes: number[],
) {
  const boundaries: number[] = [];
  let sum = 0;
  for (let i = 0; i < groupSizes.length - 1; i++) {
    sum += groupSizes[i];
    boundaries.push(sum);
  }

  const prompt =
    "Écris 10 propositions françaises différentes et naturelles.\n" +
    "Chaque proposition doit contenir EXACTEMENT " + total + " mots.\n" +
    "Contexte : " + (body.context || "libre") + "\n" +
    "Ton : " + (body.tone || "naturel") + "\n" +
    "Destinataire : " + (body.relation || "non précisé") + "\n" +
    "Chaque proposition doit pouvoir rester naturelle si des virgules sont ajoutées après les mots " +
    boundaries.join(", ") + ".\n" +
    "Une proposition par ligne. Ne numérote pas. Pas d'explication.";

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ask(env, prompt, 300, 0.85);

    const lines = raw
      .split(/\n+/)
      .map((line) =>
        line
          .replace(/^\s*[-•*\d.)]+\s*/, "")
          .replace(/^["«]+|["»]+$/g, "")
          .replace(/[.!?;:]+$/g, "")
          .trim(),
      )
      .filter(Boolean);

    for (const line of lines) {
      const words = wordsOf(line);
      if (words.length === total) return words;
    }
  }

  throw new Error("Impossible de créer une phrase de base rapidement.");
}

async function replacementOptions(
  env: Env,
  body: Body,
  baseZone: string,
  wordIndex: number,
  word: string,
  constraint: Constraint,
) {
  const prompt =
    "Phrase : " + baseZone + "\n" +
    "Le mot numéro " + (wordIndex + 1) + ' est "' + word + '".\n' +
    "Propose 10 mots français pouvant remplacer UNIQUEMENT ce mot sans casser la grammaire.\n" +
    "Même rôle grammatical si possible.\n" +
    "Contrainte absolue : la " + constraint.position +
    "e lettre doit être " + constraint.letter + ".\n" +
    "Réponds uniquement avec 10 mots séparés par des virgules.";

  const raw = await ask(env, prompt, 100, 0.8);
  return parseCandidates(raw).filter((candidate) =>
    validWord(candidate, constraint),
  );
}

async function repairInParallel(
  env: Env,
  body: Body,
  baseWords: string[],
  groupSizes: number[],
  constraints: Constraint[],
) {
  const baseZone = buildZoneFromWords(baseWords, groupSizes);
  const badIndexes: number[] = [];

  for (let i = 0; i < constraints.length; i++) {
    if (!validWord(baseWords[i], constraints[i])) badIndexes.push(i);
  }

  if (badIndexes.length === 0) return baseWords;

  for (let round = 0; round < 2; round++) {
    const results = await Promise.all(
      badIndexes.map((i) =>
        replacementOptions(
          env,
          body,
          baseZone,
          i,
          baseWords[i],
          constraints[i],
        ),
      ),
    );

    const repaired = [...baseWords];
    let allFound = true;

    for (let j = 0; j < badIndexes.length; j++) {
      const options = results[j];
      if (!options.length) {
        allFound = false;
        continue;
      }
      repaired[badIndexes[j]] = options[0];
    }

    if (allFound) return repaired;
  }

  throw new Error("Certains mots n'ont pas pu être corrigés.");
}

function quickLetter(body: Body, zone: string) {
  const tone = (body.tone || "Naturel").toLowerCase();
  const info = (body.visibleInfo || "").trim();

  let hello = "Bonjour,";
  let intro = "Je voulais simplement vous transmettre ces quelques informations.";
  let outro = "Bien à vous.";

  if (tone.includes("amical")) {
    hello = "Salut,";
    intro = "Je voulais juste te tenir au courant.";
    outro = "À bientôt.";
  } else if (tone.includes("formel") || tone.includes("professionnel")) {
    intro = "Je souhaitais simplement vous transmettre ces quelques informations.";
    outro = "Bien cordialement.";
  } else if (tone.includes("myst")) {
    intro = "Je préfère vous transmettre cela simplement.";
  }

  const extra = info ? "\n\n" + info : "";
  return hello + "\n\n" + intro + " (" + zone + ")." + extra + "\n\n" + outro;
}

async function handleGenerate(request: Request, env: Env) {
  const body = (await request.json()) as Body;
  const secret = normalizeSecret(body.secret || "");

  if (!secret) {
    return Response.json({ error: "Le message secret est vide." }, { status: 400 });
  }

  if (secret.length > 80) {
    return Response.json(
      { error: "Le message secret est trop long. Utilise des abréviations courtes." },
      { status: 400 },
    );
  }

  const { encodedGroups, constraints } = prepare(secret);
  const groupSizes = encodedGroups.map((g) => g.length);
  const total = constraints.length;

  let lastError = "";

  for (let restart = 0; restart < 2; restart++) {
    try {
      const baseWords = await makeBaseWords(env, body, total, groupSizes);
      const repairedWords = await repairInParallel(
        env,
        body,
        baseWords,
        groupSizes,
        constraints,
      );

      const zone = buildZoneFromWords(repairedWords, groupSizes);
      const decoded = decodeZone(zone);

      if (decoded.message !== secret) {
        throw new Error("La vérification finale du code a échoué.");
      }

      return Response.json({
        ok: true,
        text: quickLetter(body, zone),
        decoded: decoded.message,
        extraction: decoded.rawGroups,
        attempts: restart + 1,
      });
    } catch (error) {
      lastError =
        error instanceof Error ? error.message : "La génération n'a pas abouti.";
    }
  }

  return Response.json(
    { ok: false, error: lastError || "La génération n'a pas abouti." },
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
        return Response.json({ error: "Erreur pendant la génération." }, { status: 500 });
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
