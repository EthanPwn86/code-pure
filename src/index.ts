import { Env } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";
const CYCLE = [2, 3, 1, 2] as const;

interface GenerateBody {
  secret?: string;
  context?: string;
  tone?: string;
  visibleInfo?: string;
  relation?: string;
}

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

function prepareEncoding(secret: string) {
  const groups = secret.split(" ").filter(Boolean);
  const encodedGroups = groups.map(reversePairs);
  const constraints: Array<{ word: number; position: number; letter: string; group: number }> = [];
  let wordIndex = 0;

  encodedGroups.forEach((group, groupIndex) => {
    for (const letter of group) {
      constraints.push({
        word: wordIndex + 1,
        position: CYCLE[wordIndex % CYCLE.length],
        letter,
        group: groupIndex + 1,
      });
      wordIndex++;
    }
  });

  return { encodedGroups, constraints };
}

function lettersOnly(token: string): string {
  return token
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function extractZone(text: string): string | null {
  const match = text.match(/\(([\s\S]*?)\)/);
  return match ? match[1].trim() : null;
}

function decodeZone(zone: string) {
  const groups = zone.split(",");
  const rawGroups: string[] = [];
  let globalWordIndex = 0;

  for (const group of groups) {
    const tokens = group.trim().split(/\s+/).filter(Boolean);
    let raw = "";

    for (const token of tokens) {
      const word = lettersOnly(token);
      if (!word) continue;

      const position = CYCLE[globalWordIndex % CYCLE.length];
      if (word.length < position) {
        throw new Error(`Mot trop court : "${token}" pour la position ${position}.`);
      }
      raw += word[position - 1];
      globalWordIndex++;
    }

    rawGroups.push(raw);
  }

  const decodedGroups = rawGroups.map(reversePairs);
  return {
    rawGroups,
    decodedGroups,
    message: decodedGroups.join(" "),
  };
}

function validateCandidate(text: string, expected: string) {
  const zone = extractZone(text);
  if (!zone) {
    return { valid: false, reason: "Aucune zone entre parenthèses.", decoded: "" };
  }

  try {
    const decoded = decodeZone(zone);
    return {
      valid: decoded.message === expected,
      reason:
        decoded.message === expected
          ? ""
          : `Le texte se décode en "${decoded.message}" au lieu de "${expected}".`,
      decoded: decoded.message,
      rawGroups: decoded.rawGroups,
    };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : "Décodage impossible.",
      decoded: "",
    };
  }
}

function buildPrompt(
  secret: string,
  body: GenerateBody,
  encodedGroups: string[],
  constraints: Array<{ word: number; position: number; letter: string; group: number }>,
) {
  const constraintLines = constraints
    .map((c) => `- Mot ${c.word} : la ${c.position}e lettre doit être "${c.letter}"`)
    .join("\n");

  return `Tu dois écrire une petite lettre ou un message en français qui paraît parfaitement naturel, crédible et banal.

BUT APPARENT
Contexte : ${body.context?.trim() || "Libre, mais cohérent"}
Ton : ${body.tone?.trim() || "Naturel"}
Destinataire / relation : ${body.relation?.trim() || "Non précisé"}
Informations visibles à intégrer : ${body.visibleInfo?.trim() || "Aucune"}

CONTRAINTE SECRÈTE
Le message caché final doit être exactement :
${secret}

Tu dois cacher exactement cette chaîne intermédiaire :
${encodedGroups.join(", ")}

RÈGLES ABSOLUES
1. Une seule portion du texte doit être placée entre parenthèses : ( ... ).
2. SEULS les mots entre ces parenthèses participent au code.
3. Dans cette zone, la position à lire suit 2-3-1-2 puis recommence en boucle, sans jamais repartir à zéro après une virgule.
4. Les virgules de la zone codée sont obligatoires et représentent les espaces du message secret.
5. Il doit y avoir exactement ${encodedGroups.length} groupe(s) dans la zone codée, séparé(s) par ${Math.max(0, encodedGroups.length - 1)} virgule(s).
6. La zone codée doit contenir exactement ${constraints.length} mots utiles, ni plus ni moins.
7. Chaque groupe doit rester grammaticalement intégré à la phrase. N'écris jamais une liste de mots, une suite artificielle ou une salade de mots.
8. Tu peux écrire autant de texte naturel que nécessaire AVANT et APRÈS les parenthèses pour rendre le message crédible.
9. N'explique jamais le code et ne donne aucune analyse.
10. Retourne UNIQUEMENT le texte final destiné à être envoyé.

CONTRAINTES LETTRE PAR LETTRE DANS LA ZONE
${constraintLines}

Avant de répondre, vérifie silencieusement chaque mot un par un. Le texte doit respecter toutes les contraintes ET avoir un sens naturel en français.`;
}

async function generateCandidate(env: Env, prompt: string, correction?: string) {
  const messages = [
    {
      role: "system",
      content:
        "Tu es un rédacteur français extrêmement rigoureux. Tu respectes exactement les contraintes de position de lettres tout en produisant un texte naturel. Tu réponds uniquement avec le texte final demandé.",
    },
    { role: "user", content: prompt },
  ];

  if (correction) {
    messages.push({
      role: "user",
      content:
        "Ta tentative précédente était invalide. Corrige-la entièrement. " +
        correction +
        " Repars de zéro si nécessaire et réponds uniquement avec le nouveau texte final.",
    });
  }

  const result = (await env.AI.run(MODEL_ID, {
    messages,
    max_tokens: 700,
    temperature: 0.65,
  })) as unknown as { response?: string };

  return typeof result?.response === "string" ? result.response.trim() : "";
}

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as GenerateBody;
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

    const { encodedGroups, constraints } = prepareEncoding(secret);
    const prompt = buildPrompt(secret, body, encodedGroups, constraints);

    let lastCandidate = "";
    let lastReason = "";

    for (let attempt = 1; attempt <= 4; attempt++) {
      const correction =
        attempt === 1
          ? undefined
          : `La validation automatique a échoué : ${lastReason} Respecte exactement la chaîne intermédiaire "${encodedGroups.join(", ")}".`;

      const candidate = await generateCandidate(env, prompt, correction);
      lastCandidate = candidate;

      if (!candidate) {
        lastReason = "L'IA n'a renvoyé aucun texte.";
        continue;
      }

      const validation = validateCandidate(candidate, secret);
      if (validation.valid) {
        return Response.json({
          ok: true,
          text: candidate,
          decoded: validation.decoded,
          extraction: validation.rawGroups,
          attempts: attempt,
        });
      }

      lastReason = validation.reason;
    }

    return Response.json(
      {
        ok: false,
        error:
          "L'IA n'a pas réussi à produire un texte valide après plusieurs tentatives. Clique sur Régénérer.",
        reason: lastReason,
      },
      { status: 422 },
    );
  } catch (error) {
    console.error("Generation error:", error);
    return Response.json(
      { error: "Erreur pendant la génération du texte." },
      { status: 500 },
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
      return handleGenerate(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
