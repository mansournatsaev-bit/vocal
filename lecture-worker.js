// Synthèse vocale de la page ordinateur, en arrière-plan pour ne pas figer la page.
// Voix Piper (libre), calculée dans le navigateur : le texte ne quitte pas l'ordinateur, et le son
// obtenu peut être envoyé dans l'appel (la voix intégrée du navigateur, elle, ne le peut pas).
// Le modèle (63 Mo) est téléchargé une seule fois, puis gardé par le navigateur ; il reste chargé
// en mémoire d'un morceau à l'autre, ce qui rend la synthèse environ 3 fois plus rapide que la lecture.

import * as piper from 'https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/+esm';
import { createPiperPhonemize } from 'https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/dist/piper-DeOu3H9E.js';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/+esm';

const VOIX = 'fr_FR-siwis-medium';
const AVANCE = 15;        // morceaux préparés au plus en avance sur la lecture (limite la mémoire)
const PREMIER_LOT = 1;    // le premier morceau part seul, pour commencer à lire au plus vite
const LOT = 20;

let modele = null;        // promesse { config, session }
let serie = 0, joue = 0;  // lecture en cours, et morceau que la page est en train de lire

onmessage = e => {
  const m = e.data;
  if (m.t === 'lire') { serie = m.serie; joue = 0; preparer(m.serie, m.textes); }
  else if (m.t === 'position' && m.serie === serie) joue = m.i;
  else if (m.t === 'stop') serie = 0;
  else if (m.t === 'prechauffer') charger().catch(() => {});  // la voix se charge avant le clic sur Lire
};

// Un fichier de la voix : pris dans le stockage du navigateur s'il y est déjà, sinon téléchargé puis
// rangé là pour les fois suivantes. L'écriture est finie (ou absente) : jamais de fichier à moitié écrit.
async function fichier(nom, progres) {
  const dossier = await (await navigator.storage.getDirectory()).getDirectoryHandle('piper-vocal', { create: true });
  try {
    const garde = await (await dossier.getFileHandle(nom)).getFile();
    if (garde.size) return garde.arrayBuffer();
  } catch {}
  const reponse = await fetch(`${piper.HF_BASE}/${piper.PATH_MAP[VOIX].replace(/[^/]+$/, '')}${nom}`);
  if (!reponse.ok) throw new Error('téléchargement de la voix impossible (' + reponse.status + ')');
  const total = Number(reponse.headers.get('Content-Length')) || 0, lecteur = reponse.body.getReader(), parts = [];
  for (let recu = 0;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    parts.push(value);
    recu += value.length;
    if (total) progres?.(Math.round(recu * 100 / total));
  }
  const donnees = await new Blob(parts).arrayBuffer();
  try {
    const ecriture = await (await dossier.getFileHandle(nom, { create: true })).createWritable();
    await ecriture.write(donnees);
    await ecriture.close();
  } catch (e) {
    console.warn('Voix non gardée par le navigateur', e);  // elle sera retéléchargée la prochaine fois
  }
  return donnees;
}

function charger() {
  if (!modele) {
    modele = (async () => {
      const nom = piper.PATH_MAP[VOIX].split('/').at(-1);
      const config = JSON.parse(new TextDecoder().decode(await fichier(nom + '.json')));
      const reseau = await fichier(nom, pourcent => postMessage({ t: 'telechargement', pourcent }));
      postMessage({ t: 'chargement' });
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = piper.ONNX_BASE;
      const session = await ort.InferenceSession.create(reseau);
      return { config, session };
    })();
    modele.catch(() => { modele = null; });  // nouvel essai possible à la lecture suivante
  }
  return modele;
}

// Texte → phonèmes, pour plusieurs morceaux d'un coup (le phonémiseur met ~1 s à démarrer).
async function phonemes(textes, voix) {
  const lignes = [];
  const module = await createPiperPhonemize({
    print: l => lignes.push(JSON.parse(l).phoneme_ids),
    printErr: l => console.warn('Phonémiseur', l),
    locateFile: f => f.endsWith('.wasm') ? piper.WASM_BASE + '.wasm' : f.endsWith('.data') ? piper.WASM_BASE + '.data' : f,
  });
  module.callMain(['-l', voix, '--input', JSON.stringify(textes.map(text => ({ text }))), '--espeak_data', '/espeak-ng-data']);
  if (lignes.length === textes.length) return lignes;
  if (textes.length === 1) throw new Error('texte illisible par la voix');
  // Un morceau a été refusé : on les repasse un par un pour garder la correspondance.
  const un = [];
  for (const t of textes) un.push((await phonemes([t], voix))[0]);
  return un;
}

async function preparer(maSerie, textes) {
  try {
    const { config, session } = await charger();
    const { noise_scale, length_scale, noise_w } = config.inference;
    for (let debut = 0; debut < textes.length;) {
      const lot = textes.slice(debut, debut + (debut ? LOT : PREMIER_LOT));
      const ids = await phonemes(lot, config.espeak.voice);
      for (let k = 0; k < lot.length; k++) {
        const i = debut + k;
        while (maSerie === serie && i > joue + AVANCE) await new Promise(ok => setTimeout(ok, 200));
        if (maSerie !== serie) return;
        const entree = {
          input: new ort.Tensor('int64', ids[k], [1, ids[k].length]),
          input_lengths: new ort.Tensor('int64', [ids[k].length]),
          scales: new ort.Tensor('float32', [noise_scale, length_scale, noise_w]),
        };
        if (Object.keys(config.speaker_id_map || {}).length) entree.sid = new ort.Tensor('int64', [0]);
        const { output } = await session.run(entree);
        if (maSerie !== serie) return;
        const wav = encoderWav(output.data, config.audio.sample_rate);
        postMessage({ t: 'pret', serie: maSerie, i, wav }, [wav]);
      }
      debut += lot.length;
    }
  } catch (e) {
    if (maSerie === serie) postMessage({ t: 'erreur', serie: maSerie, message: String(e.message || e) });
  }
}

function encoderWav(f32, sr) {
  const n = f32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const texte = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  texte(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); texte(8, 'WAVE');
  texte(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  texte(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
