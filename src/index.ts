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
  index: number;
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
  let index = 0;

  encodedGroups.forEach((group, groupIndex) => {
    for (const letter of group) {
      constraints.push({
        index,
        position: CYCLE[index % CYCLE.length],
        letter,
        group: groupIndex,
      });
      index++;
    }
  });

  return { encodedGroups, constraints };
}

function validForConstraint(word: string, constraint: Constraint) {
  if (/['’\-]/.test(word)) return false;
  const w = cleanWord(word);
  return w.length >= constraint.position &&
    w[constraint.position - 1] === constraint.letter;
}

function parseWordList(text: string) {
  return Array.from(new Set(
    text
      .replace(/[\[\]{}"]/g, " ")
      .split(/[\n,;|]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .flatMap((x) => x.split(/\s+/))
      .map((x) => x.replace(/^[^A-Za-zÀ-ÿ0-9]+|[^A-Za-zÀ-ÿ0-9]+$/g, ""))
      .filter(Boolean)
  ));
}

async function runText(
  env: Env,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens = 180,
  temperature = 0.5,
) {
  const result = (await env.AI.run(MODEL, {
    messages,
    max_tokens: maxTokens,
    temperature,
  })) as unknown as { response?: string };

  return typeof result?.response === "string" ? result.response.trim() : "";
}

async function candidateWords(env: Env, constraint: Constraint) {
  const base =
    "Donne 25 mots français simples et courants. " +
    "Contrainte unique : la " + constraint.position +
    "e lettre du mot doit être exactement " + constraint.letter + ". " +
    "Réponds uniquement avec les mots séparés par des virgules. " +
    "Pas d'apostrophe, pas de tiret, pas d'explication.";

  const first = await runText(
    env,
    [
      {
        role: "system",
        content:
          "Tu proposes uniquement des mots français respectant exactement une position de lettre.",
      },
      { role: "user", content: base },
    ],
    150,
    0.7,
  );

  let words = parseWordList(first).filter((w) =>
    validForConstraint(w, constraint),
  );

  if (words.length < 6) {
    const second = await runText(
      env,
      [
        {
          role: "system",
          content:
            "Tu proposes uniquement des mots français respectant exactement une position de lettre.",
        },
        {
          role: "user",
          content:
            base +
            " Cherche d'autres mots. Tu peux utiliser pluriels, conjugaisons et mots courants empruntés.",
        },
      ],
      170,
      0.9,
    );

    words = Array.from(new Set(
      words.concat(
        parseWordList(second).filter((w) =>
          validForConstraint(w, constraint),
        ),
      ),
    ));
  }

  return words.slice(0, 16);
}

function decodeZone(zone: string) {
  const groups = zone.split(",");
  let wordIndex = 0;
  const rawGroups: string[] = [];

  for (const group of groups) {
    let raw = "";
    const words = group.trim().split(/\s+/).filter(Boolean);

    for (const token of words) {
      const w = cleanWord(token);
      const position = CYCLE[wordIndex % CYCLE.length];

      if (w.length < position) {
        throw new Error("Mot trop court dans la zone codée.");
      }

      raw += w[position - 1];
      wordIndex++;
    }

    rawGroups.push(raw);
  }

  return {
    rawGroups,
    message: rawGroups.map(reversePairs).join(" "),
  };
}

function validateZone(
  zone: string,
  secret: string,
  encodedGroups: string[],
  constraints: Constraint[],
) {
  const groups = zone.split(",");
  const groupWords = groups.map((g) =>
    g.trim().split(/\s+/).filter(Boolean),
  );
  const flat = groupWords.flat();
  const issues: string[] = [];

  if (groups.length !== encodedGroups.length) {
    issues.push(
      "Il faut " + encodedGroups.length +
      " groupes, pas " + groups.length + ".",
    );
  }

  encodedGroups.forEach((g, i) => {
    const count = groupWords[i]?.length ?? 0;
    if (count !== g.length) {
      issues.push(
        "Groupe " + (i + 1) + " : " + count +
        " mots au lieu de " + g.length + ".",
      );
    }
  });

  if (flat.length !== constraints.length) {
    issues.push(
      "Il faut " + constraints.length +
      " mots au total, pas " + flat.length + ".",
    );
  }

  for (let i = 0; i < Math.min(flat.length, constraints.length); i++) {
    if (!validForConstraint(flat[i], constraints[i])) {
      issues.push(
        "Mot " + (i + 1) + " non compatible : " + flat[i] + ".",
      );
    }
  }

  let decoded = "";
  try {
    decoded = decodeZone(zone).message;
    if (decoded !== secret) {
      issues.push(
        "Décodage obtenu : " + decoded + " au lieu de " + secret + ".",
      );
    }
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "Décodage impossible.",
    );
  }

  return { ok: issues.length === 0, decoded, issues };
}

async function buildZone(
  env: Env,
  body: Body,
  secret: string,
  encodedGroups: string[],
  constraints: Constraint[],
  pools: string[][],
) {
  const groupSizes = encodedGroups.map((g) => g.length);
  const poolText = pools
    .map((pool, i) =>
      "Emplacement " + (i + 1) +
      " : [" + pool.join(", ") + "]"
    )
    .join("\n");

  const structureText = groupSizes
    .map((size, i) =>
      "groupe " + (i + 1) + " = " + size + " mots"
    )
    .join(", ");

  let feedback = "";

  for (let attempt = 1; attempt <= 5; attempt++) {
    const prompt =
      "Construis UNE SEULE proposition française naturelle destinée à une lettre.\n\n" +
      "Contexte apparent : " + (body.context || "libre") + "\n" +
      "Ton : " + (body.tone || "naturel") + "\n" +
      "Destinataire : " + (body.relation || "non précisé") + "\n\n" +
      "Choisis exactement UN mot dans chaque liste ci-dessous, dans l'ordre.\n" +
      "Tu n'as pas le droit d'utiliser un mot absent de sa liste.\n" +
      "Structure exacte : " + structureText + "\n" +
      "Sépare les groupes uniquement par une virgule suivie d'un espace.\n" +
      "N'ajoute aucune autre ponctuation.\n" +
      "Réponds uniquement avec la proposition, sans parenthèses.\n\n" +
      poolText + "\n\n" +
      "La proposition complète doit avoir un vrai sens en français, pas une suite de mots." +
      (feedback ? "\nCorrection : " + feedback : "");

    const candidate = await runText(
      env,
      [
        {
          role: "system",
          content:
            "Tu construis une phrase française naturelle en sélectionnant des mots dans des listes imposées. Respecte exactement l'ordre et les virgules.",
        },
        { role: "user", content: prompt },
      ],
      220,
      0.35,
    );

    const zone = candidate
      .replace(/^["'«]+|["'»]+$/g, "")
      .replace(/^\(|\)$/g, "")
      .trim();

    const validation = validateZone(
      zone,
      secret,
      encodedGroups,
      constraints,
    );

    if (validation.ok) return zone;
    feedback = validation.issues.join(" ");
  }

  throw new Error(
    "Impossible d'assembler une phrase naturelle avec les mots compatibles.",
  );
}

async function wrapLetter(env: Env, body: Body, zone: string) {
  const literal = "(" + zone + ")";

  const prompt =
    "Écris une petite lettre française naturelle et crédible.\n\n" +
    "Contexte : " + (body.context || "libre") + "\n" +
    "Ton : " + (body.tone || "naturel") + "\n" +
    "Destinataire : " + (body.relation || "non précisé") + "\n" +
    "Informations visibles : " + (body.visibleInfo || "aucune") + "\n\n" +
    "Intègre EXACTEMENT, caractère pour caractère, ce passage :\n" +
    literal + "\n\n" +
    "Ne modifie aucun mot, aucune virgule ni parenthèse de ce passage. " +
    "Tu peux écrire librement avant et après pour que la lettre ait un sens naturel. " +
    "Réponds uniquement avec la lettre finale.";

  return runText(
    env,
    [
      {
        role: "system",
        content:
          "Tu es un rédacteur français. Tu intègres littéralement le passage imposé sans le modifier.",
      },
      { role: "user", content: prompt },
    ],
    420,
    0.55,
  );
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

  const unique = new Map<string, Promise<string[]>>();

  for (const c of constraints) {
    const key = c.position + ":" + c.letter;
    if (!unique.has(key)) {
      unique.set(key, candidateWords(env, c));
    }
  }

  const poolMap = new Map<string, string[]>();

  await Promise.all(
    Array.from(unique.entries()).map(async ([key, promise]) => {
      poolMap.set(key, await promise);
    }),
  );

  const pools = constraints.map((c) =>
    poolMap.get(c.position + ":" + c.letter) || [],
  );

  const missing = pools.findIndex((p) => p.length < 3);

  if (missing !== -1) {
    const c = constraints[missing];
    return Response.json(
      {
        error:
          "Pas assez de mots trouvés pour le mot " + (missing + 1) +
          " (" + c.position + "e lettre = " + c.letter + "). Régénère.",
      },
      { status: 422 },
    );
  }

  try {
    const zone = await buildZone(
      env,
      body,
      secret,
      encodedGroups,
      constraints,
      pools,
    );

    const decoded = decodeZone(zone);

    if (decoded.message !== secret) {
      throw new Error("La zone n'a pas passé la vérification.");
    }

    const finalText = await wrapLetter(env, body, zone);
    const literal = "(" + zone + ")";

    if (!finalText.includes(literal)) {
      throw new Error(
        "La rédaction finale a modifié la zone codée. Clique sur Régénérer.",
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
