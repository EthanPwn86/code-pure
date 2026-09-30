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

type Constraint = { pos: number; letter: string };

function normalizeSecret(s: string) {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function reversePairs(s: string) {
  let out = "";
  for (let i = 0; i < s.length; i += 2) {
    out += i + 1 < s.length ? s[i + 1] + s[i] : s[i];
  }
  return out;
}

function cleanWord(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function prepare(secret: string) {
  const encodedGroups = secret.split(" ").filter(Boolean).map(reversePairs);
  const grouped: Constraint[][] = [];
  let wordIndex = 0;

  for (const group of encodedGroups) {
    const constraints: Constraint[] = [];
    for (const letter of group) {
      constraints.push({
        pos: CYCLE[wordIndex % CYCLE.length],
        letter,
      });
      wordIndex++;
    }
    grouped.push(constraints);
  }

  return { encodedGroups, grouped };
}

function validateFragment(fragment: string, constraints: Constraint[]) {
  const words = fragment.trim().split(/\s+/).filter(Boolean);
  const issues: string[] = [];

  if (words.length !== constraints.length) {
    issues.push(`Il faut exactement ${constraints.length} mots, pas ${words.length}.`);
  }

  for (let i = 0; i < Math.min(words.length, constraints.length); i++) {
    const word = cleanWord(words[i]);
    const c = constraints[i];

    if (word.length < c.pos) {
      issues.push(`Mot ${i + 1} "${words[i]}" trop court pour la position ${c.pos}.`);
    } else if (word[c.pos - 1] !== c.letter) {
      issues.push(
        `Mot ${i + 1} "${words[i]}" : la ${c.pos}e lettre est "${word[c.pos - 1]}", il faut "${c.letter}".`,
      );
    }

    if (/['’-]/.test(words[i])) {
      issues.push(`Mot ${i + 1} "${words[i]}" contient une apostrophe ou un tiret.`);
    }
  }

  return { ok: issues.length === 0, words, issues };
}

function decodeZone(zone: string) {
  const groups = zone.split(",");
  let wordIndex = 0;
  const rawGroups: string[] = [];

  for (const group of groups) {
    let raw = "";
    for (const token of group.trim().split(/\s+/).filter(Boolean)) {
      const word = cleanWord(token);
      const pos = CYCLE[wordIndex % CYCLE.length];
      if (word.length < pos) throw new Error("Mot trop court.");
      raw += word[pos - 1];
      wordIndex++;
    }
    rawGroups.push(raw);
  }

  return {
    rawGroups,
    message: rawGroups.map(reversePairs).join(" "),
  };
}

async function ask(env: Env, messages: Array<{ role: "system" | "user"; content: string }>, maxTokens = 120) {
  const result = (await env.AI.run(MODEL, {
    messages,
    max_tokens: maxTokens,
    temperature: 0.45,
  })) as unknown as { response?: string };

  return typeof result?.response === "string" ? result.response.trim() : "";
}

async function generateGroup(
  env: Env,
  body: Body,
  constraints: Constraint[],
  groupIndex: number,
  groupCount: number,
  previous: string[],
) {
  const rules = constraints
    .map((c, i) => `mot ${i + 1}: ${c.pos}e lettre = ${c.letter}`)
    .join("; ");

  let feedback = "";

  for (let attempt = 1; attempt <= 4; attempt++) {
    const positionHint =
      groupIndex === 0
        ? "Ce fragment doit pouvoir commencer naturellement une proposition."
        : groupIndex === groupCount - 1
          ? "Ce fragment doit pouvoir terminer naturellement la proposition."
          : "Ce fragment doit continuer naturellement la proposition après une virgule.";

    const prompt = `Contexte de la lettre: ${body.context || "libre"}.
Ton: ${body.tone || "naturel"}.
Texte déjà choisi avant ce fragment: ${previous.length ? previous.join(", ") : "aucun"}.

Produis EXACTEMENT ${constraints.length} mots français simples, séparés uniquement par des espaces, sans ponctuation.
${positionHint}
Le fragment doit être grammatical et naturel avec ce qui précède.
Contraintes obligatoires: ${rules}.
Pas d'apostrophe, pas de tiret, pas d'abréviation.
Réponds UNIQUEMENT avec les ${constraints.length} mots.
${feedback ? "Correction nécessaire: " + feedback : ""}`;

    const candidate = await ask(
      env,
      [
        {
          role: "system",
          content:
            "Tu construis des fragments de phrase française sous contraintes de lettres. Tu dois respecter exactement le nombre de mots et les positions demandées.",
        },
        { role: "user", content: prompt },
      ],
      80,
    );

    const result = validateFragment(candidate, constraints);
    if (result.ok) return result.words.join(" ");

    feedback = result.issues.join(" ");
  }

  throw new Error(`Impossible de construire naturellement le groupe ${groupIndex + 1}.`);
}

async function wrapLetter(env: Env, body: Body, zone: string) {
  const literal = `(${zone})`;
  const prompt = `Écris une petite lettre française naturelle et crédible.

Contexte: ${body.context || "libre"}.
Ton: ${body.tone || "naturel"}.
Destinataire: ${body.relation || "non précisé"}.
Informations visibles à intégrer: ${body.visibleInfo || "aucune"}.

Tu dois intégrer EXACTEMENT, caractère pour caractère, ce passage dans la lettre:
${literal}

Ne change aucun mot, aucune virgule ni parenthèse de ce passage.
Tu peux écrire librement avant et après pour que l'ensemble ait un sens naturel.
Réponds uniquement avec la lettre finale.`;

  const text = await ask(
    env,
    [
      {
        role: "system",
        content:
          "Tu es un rédacteur français. Tu dois intégrer littéralement le passage imposé sans le modifier.",
      },
      { role: "user", content: prompt },
    ],
    350,
  );

  return text;
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

  const { grouped } = prepare(secret);
  const fragments: string[] = [];

  try {
    for (let i = 0; i < grouped.length; i++) {
      const fragment = await generateGroup(env, body, grouped[i], i, grouped.length, fragments);
      fragments.push(fragment);
    }

    const zone = fragments.join(", ");
    const decoded = decodeZone(zone);

    if (decoded.message !== secret) {
      return Response.json(
        { error: "La zone générée n'a pas passé la vérification interne." },
        { status: 422 },
      );
    }

    const finalText = await wrapLetter(env, body, zone);
    const literal = `(${zone})`;

    if (!finalText.includes(literal)) {
      return Response.json(
        { error: "La rédaction finale a modifié la zone codée. Clique sur Régénérer." },
        { status: 422 },
      );
    }

    return Response.json({
      ok: true,
      text: finalText,
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
            : "La génération n'a pas abouti. Clique sur Régénérer.",
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
        return Response.json({ error: "Erreur pendant la génération." }, { status: 500 });
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
