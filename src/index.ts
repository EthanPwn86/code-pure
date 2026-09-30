import { Env } from "./types";

const MODEL="@cf/meta/llama-3.1-8b-instruct-fp8";
const C=[2,3,1,2] as const;

type Body={secret?:string;context?:string;tone?:string;visibleInfo?:string;relation?:string};
type Constraint={pos:number;letter:string};

const norm=(s:string)=>s.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^A-Z0-9 ]+/g," ").replace(/\s+/g," ").trim();
const rev=(s:string)=>{let o="";for(let i=0;i<s.length;i+=2)o+=i+1<s.length?s[i+1]+s[i]:s[i];return o};
const clean=(s:string)=>s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^A-Za-z0-9]/g,"").toUpperCase();

function prep(secret:string){
  const enc=secret.split(" ").filter(Boolean).map(rev);
  const cons:Constraint[]=[];let i=0;
  for(const g of enc)for(const letter of g){cons.push({pos:C[i%C.length],letter});i++}
  return {enc,cons};
}

function inspect(text:string,secret:string,enc:string[],cons:Constraint[]){
  const m=text.match(/\(([\s\S]*?)\)/);
  if(!m)return {ok:false,decoded:"",feedback:"Il manque la zone entre parenthèses."};
  const groups=m[1].split(",");
  const toks=groups.map(g=>g.trim().split(/\s+/).filter(Boolean));
  const flat=toks.flat();
  const issues:string[]=[];
  if(groups.length!==enc.length)issues.push(`Il faut ${enc.length} groupes séparés par ${Math.max(0,enc.length-1)} virgules.`);
  enc.forEach((g,i)=>{if((toks[i]?.length||0)!==g.length)issues.push(`Groupe ${i+1}: ${toks[i]?.length||0} mots au lieu de ${g.length}.`)});
  if(flat.length!==cons.length)issues.push(`Il faut exactement ${cons.length} mots dans la zone, pas ${flat.length}.`);
  let raw="";const raws:string[]=[];let wi=0;
  for(let gi=0;gi<toks.length;gi++){
    let rg="";
    for(const token of toks[gi]){
      if(wi>=cons.length){wi++;continue}
      const w=clean(token),c=cons[wi];
      if(w.length<c.pos)issues.push(`Mot ${wi+1} "${token}": trop court, position ${c.pos} attendue.`);
      else if(w[c.pos-1]!==c.letter)issues.push(`Mot ${wi+1} "${token}": lettre ${c.pos} = ${w[c.pos-1]}, attendu ${c.letter}.`);
      if(w.length>=c.pos)rg+=w[c.pos-1];
      wi++;
    }
    raws.push(rg);
  }
  raw=raws.map(rev).join(" ");
  if(raw!==secret)issues.push(`Décodage obtenu "${raw}" au lieu de "${secret}".`);
  return {ok:issues.length===0&&raw===secret,decoded:raw,feedback:issues.join("\n")};
}

function prompt(secret:string,b:Body,enc:string[],cons:Constraint[]){
  const sizes=enc.map((g,i)=>`groupe ${i+1}: ${g.length} mots`).join(", ");
  const rules=cons.map((c,i)=>`mot ${i+1}: ${c.pos}e lettre = ${c.letter}`).join("\n");
  return `Écris UNIQUEMENT une petite lettre française naturelle et crédible.

Contexte apparent: ${b.context||"libre"}
Ton: ${b.tone||"naturel"}
Destinataire: ${b.relation||"non précisé"}
Infos visibles: ${b.visibleInfo||"aucune"}

Message secret final: ${secret}
Chaîne intermédiaire: ${enc.join(", ")}
Structure de la zone codée: ${sizes}

Règles strictes:
- Une seule zone entre parenthèses ( ... ).
- Seuls les mots dans cette zone comptent.
- Positions à lire: 2,3,1,2 puis répétition continue.
- Les virgules de la zone marquent les espaces et NE réinitialisent PAS 2312.
- Exactement ${cons.length} mots dans la zone.
- Évite apostrophes et mots composés dans la zone.
- La zone doit être une vraie phrase naturelle, pas une liste de mots.
- Tu peux ajouter du texte libre avant/après les parenthèses.
- Réponds uniquement avec la lettre finale.

Contraintes mot par mot:
${rules}

Construis d'abord la zone, vérifie chaque position, puis rends l'ensemble naturel.`;
}

async function ask(env:Env,messages:any[]){
  const r=await env.AI.run(MODEL,{messages,max_tokens:800,temperature:0.35}) as any;
  return typeof r?.response==="string"?r.response.trim():"";
}

async function generate(req:Request,env:Env){
  const b=await req.json() as Body;
  const secret=norm(b.secret||"");
  if(!secret)return Response.json({error:"Le message secret est vide."},{status:400});
  const {enc,cons}=prep(secret);
  const messages:any[]=[
    {role:"system",content:"Tu es un rédacteur français extrêmement rigoureux. Tu dois respecter exactement les contraintes de lettres et écrire un texte naturel. Réponds uniquement avec la lettre finale."},
    {role:"user",content:prompt(secret,b,enc,cons)}
  ];
  let last="";
  for(let n=1;n<=6;n++){
    const candidate=await ask(env,messages);
    if(!candidate){last="Aucun texte renvoyé.";continue}
    const v=inspect(candidate,secret,enc,cons);
    if(v.ok)return Response.json({ok:true,text:candidate,decoded:v.decoded,attempts:n});
    last=v.feedback;
    messages.push({role:"assistant",content:candidate});
    messages.push({role:"user",content:`Cette tentative est invalide. Erreurs exactes:\n${v.feedback}\nCorrige-la. Garde exactement le bon nombre de mots et de virgules, remplace les mots fautifs par des mots naturels compatibles, puis réponds uniquement avec la lettre complète corrigée.`});
  }
  return Response.json({ok:false,error:"L'IA n'a pas réussi après plusieurs corrections automatiques.",reason:last},{status:422});
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const u=new URL(request.url);
    if(u.pathname==="/api/generate"){
      if(request.method!=="POST")return new Response("Method not allowed",{status:405});
      try{return await generate(request,env)}catch(e){console.error(e);return Response.json({error:"Erreur pendant la génération."},{status:500})}
    }
    if(u.pathname.startsWith("/api/"))return new Response("Not found",{status:404});
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
