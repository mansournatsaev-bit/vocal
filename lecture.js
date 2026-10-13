// Lecture de texte (page ordinateur, colonne de droite) : on colle un texte, « Lire » le fait dire
// par une voix de synthèse envoyée dans l'appel, donc entendue sur le téléphone. Ce qui a été lu
// change de couleur, et la vitesse se règle pendant la lecture.
// La synthèse tourne dans lecture-worker.js ; le son rejoint l'appel par le mélange de ecoute.js.

const lec = {
  saisie: $('#lecture-saisie'), affichage: $('#lecture-affichage'), etat: $('#lecture-etat'),
  lire: $('#lecture-lire'), pause: $('#lecture-pause'), arreter: $('#lecture-arreter'),
  vitesse: $('#lecture-vitesse'), vitesseValeur: $('#lecture-vitesse-valeur'),
};

const TAILLE_MORCEAU_TEXTE = 220;  // caractères : assez court pour démarrer vite, assez long pour une diction naturelle
const voix = new Audio();          // joue les morceaux ; son son ne sort que dans l'appel (voir brancherVoix)
voix.preservesPitch = true;        // changer la vitesse ne change pas la hauteur de la voix

let ouvrier = null, voixBranchee = false;
let serieLecture = 0;              // numéro de la lecture en cours (0 = aucune)
let morceauxLus = [];              // { texte, mots: [{ span, fin }], poids, url }
let courant = 0, enPause = false, enAttente = false;

lec.saisie.value = memo.lire('lecture-texte') || '';
lec.saisie.addEventListener('input', () => memo.ecrire('lecture-texte', lec.saisie.value));
reglerVitesse(Number(memo.lire('lecture-vitesse')) || 1);
lec.vitesse.addEventListener('input', () => reglerVitesse(Number(lec.vitesse.value)));
lec.lire.addEventListener('click', lire);
lec.pause.addEventListener('click', basculerPause);
lec.arreter.addEventListener('click', () => arreter(''));
lec.affichage.addEventListener('click', e => {
  const i = e.target.closest?.('.mot')?.dataset.morceau;
  if (i !== undefined && serieLecture) allerA(Number(i));
});
voix.addEventListener('ended', () => allerA(courant + 1));
voix.addEventListener('error', () => { if (serieLecture && voix.src) allerA(courant + 1); });
requestAnimationFrame(suivre);

function reglerVitesse(v) {
  const vitesse = Math.max(0.5, Math.min(2, v || 1));
  // defaultPlaybackRate : la vitesse est gardée quand on passe au morceau suivant.
  voix.defaultPlaybackRate = voix.playbackRate = vitesse;
  lec.vitesse.value = vitesse;
  lec.vitesseValeur.textContent = vitesse.toFixed(1).replace('.', ',') + ' ×';
  memo.ecrire('lecture-vitesse', vitesse);
}

// ---------- Découpage et affichage du texte ----------

// Phrases regroupées en morceaux d'environ TAILLE_MORCEAU_TEXTE caractères. Chaque morceau garde
// ses espaces et retours à la ligne : l'affichage reproduit le texte collé.
function decouper(texte) {
  const phrases = texte.match(/[^.!?…\n]+[.!?…»")\]]*\s*|[.!?…\n]+\s*/g) || [];
  const morceaux = [];
  let encours = '';
  for (const p of phrases) {
    if (encours && (encours + p).length > TAILLE_MORCEAU_TEXTE) { morceaux.push(encours); encours = ''; }
    encours += p;
    if (/\n\s*$/.test(p) && encours.trim().length > 60) { morceaux.push(encours); encours = ''; }
  }
  if (encours) morceaux.push(encours);
  // Un morceau sans lettre ni chiffre (ligne de tirets, espaces) n'est pas lu : il rejoint le précédent.
  return morceaux.reduce((liste, m) => {
    if (liste.length && !/[\p{L}\p{N}]/u.test(m)) liste[liste.length - 1] += m;
    else liste.push(m);
    return liste;
  }, []).filter(m => /[\p{L}\p{N}]/u.test(m));
}

function afficher(morceaux) {
  lec.affichage.textContent = '';
  return morceaux.map((texte, i) => {
    const mots = [];
    let poids = 0;
    for (const bout of texte.split(/(\s+)/)) {
      if (!bout) continue;
      if (/^\s+$/.test(bout)) { lec.affichage.append(bout); continue; }
      const span = document.createElement('span');
      span.className = 'mot';
      span.dataset.morceau = i;
      span.textContent = bout;
      lec.affichage.append(span);
      // Durée estimée d'un mot : sa longueur, plus la pause que marque la voix sur la ponctuation.
      poids += bout.length + 1 + (/[.!?…:;]["»)\]]*$/.test(bout) ? 6 : /,$/.test(bout) ? 3 : 0);
      mots.push({ span, fin: poids });
    }
    return { texte: texte.replace(/\s+/g, ' ').trim(), mots, poids, url: null };
  });
}

// ---------- Lecture ----------

function lire() {
  const morceaux = decouper(lec.saisie.value);
  if (!morceaux.length) return dire('Colle un texte à lire.', 'attente');

  brancherVoix();
  arreter('');
  serieLecture = Date.now();
  morceauxLus = afficher(morceaux);
  courant = 0;
  enPause = false;
  enAttente = true;
  basculerVue(true);
  dire('Préparation de la voix…', 'attente');
  travailleur().postMessage({ t: 'lire', serie: serieLecture, textes: morceauxLus.map(m => m.texte) });
}

// Le son de la voix part dans le mélange envoyé au téléphone, pas dans les haut-parleurs de l'ordinateur.
function brancherVoix() {
  const m = creerMelange();
  m.ctx.resume();
  if (voixBranchee) return;
  m.ctx.createMediaElementSource(voix).connect(m.sortie);
  voixBranchee = true;
}

function travailleur() {
  if (ouvrier) return ouvrier;
  ouvrier = new Worker('lecture-worker.js?v=1', { type: 'module' });
  ouvrier.onmessage = e => {
    const m = e.data;
    if (m.t === 'telechargement') return void (serieLecture && dire(`Téléchargement de la voix (une seule fois) : ${m.pourcent} %`, 'attente'));
    if (m.t === 'chargement') return void (serieLecture && dire('Préparation de la voix…', 'attente'));
    if (m.serie !== serieLecture) return;
    if (m.t === 'erreur') return arreter('Lecture impossible : ' + m.message, 'erreur');
    if (m.t === 'pret') {
      morceauxLus[m.i].url = URL.createObjectURL(new Blob([m.wav], { type: 'audio/wav' }));
      if (enAttente && m.i === courant) jouerMorceau();
    }
  };
  ouvrier.onerror = e => {
    ouvrier = null;
    arreter('Lecture impossible : la voix n\'a pas pu se charger (connexion internet ?)', 'erreur');
  };
  return ouvrier;
}

function allerA(i) {
  if (!serieLecture) return;
  if (i >= morceauxLus.length) {
    marquer(morceauxLus.length, 1);
    return arreter('Lecture terminée.', 'ok', true);
  }
  courant = i;
  ouvrier?.postMessage({ t: 'position', serie: serieLecture, i });
  marquer(i, 0);
  if (morceauxLus[i].url) return jouerMorceau();
  // La synthèse n'est pas encore arrivée jusque-là : la lecture reprend dès que le morceau est prêt.
  enAttente = true;
  voix.pause();
  dire('Préparation de la suite…', 'attente');
}

function jouerMorceau() {
  enAttente = false;
  voix.src = morceauxLus[courant].url;
  if (!enPause) voix.play().catch(() => {});
  majEtatLecture();
}

function basculerPause() {
  if (!serieLecture) return;
  enPause = !enPause;
  if (enPause) voix.pause();
  else if (!enAttente) voix.play().catch(() => {});
  lec.pause.textContent = enPause ? 'Reprendre' : 'Pause';
  majEtatLecture();
}

// garderTexte : en fin de lecture, le texte coloré reste affiché jusqu'au prochain clic.
function arreter(message, ton = 'neutre', garderTexte = false) {
  const avait = serieLecture;
  serieLecture = 0;
  ouvrier?.postMessage({ t: 'stop' });
  voix.pause();
  voix.removeAttribute('src');
  for (const m of morceauxLus) if (m.url) URL.revokeObjectURL(m.url);
  if (!garderTexte) morceauxLus = [];
  enPause = enAttente = false;
  lec.pause.textContent = 'Pause';
  lec.pause.hidden = true;
  lec.arreter.textContent = garderTexte ? 'Modifier le texte' : 'Arrêter';
  if (!garderTexte) basculerVue(false);
  else lec.lire.hidden = false;  // « Lire » relance la lecture depuis le début
  if (avait || message) dire(message, ton);
}

function basculerVue(lecture) {
  lec.saisie.hidden = lecture;
  lec.affichage.hidden = !lecture;
  lec.lire.hidden = lecture;
  lec.pause.hidden = !lecture;
  lec.arreter.hidden = !lecture;
}

// ---------- Coloration de ce qui a été lu ----------

// Tout ce qui précède le morceau i est lu ; dans le morceau i, la part déjà dite (0 à 1).
function marquer(i, part) {
  morceauxLus.forEach((m, k) => marquerMorceau(m, k < i ? Infinity : k > i ? -1 : part * m.poids, k === i));
}

// Colore les mots du morceau dont la fin estimée est passée ; enCours : signale aussi le mot en train d'être dit.
function marquerMorceau(m, limite, enCours) {
  let prochain = null;
  for (const mot of m.mots) {
    const lu = mot.fin <= limite;
    mot.span.classList.toggle('lu', lu);
    mot.span.classList.remove('courant');
    if (!lu && !prochain) prochain = mot;
  }
  if (prochain && enCours && serieLecture) prochain.span.classList.add('courant');
}

let dernierMotVu = null;
function suivre() {
  requestAnimationFrame(suivre);
  if (!serieLecture || enAttente || !voix.duration) return;
  const m = morceauxLus[courant];
  marquerMorceau(m, Math.min(1, voix.currentTime / voix.duration) * m.poids, true);
  // Le mot en cours reste visible dans la zone.
  const mot = lec.affichage.querySelector('.courant');
  if (mot && mot !== dernierMotVu) {
    dernierMotVu = mot;
    const zone = lec.affichage.getBoundingClientRect(), r = mot.getBoundingClientRect();
    if (r.bottom > zone.bottom - 24 || r.top < zone.top + 24) mot.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ---------- État ----------

function majEtatLecture() {
  if (!serieLecture) return;
  const ou = `${courant + 1}/${morceauxLus.length}`;
  if (enPause) return dire(`En pause (${ou})`, 'neutre');
  // Sans appel en cours, la voix ne va nulle part : on le dit plutôt que de lire dans le vide.
  if (!(appel && debutAppel)) return dire(`Lecture ${ou} — le téléphone n'est pas en appel, il n'entend rien`, 'erreur');
  dire(`Lecture ${ou} — le téléphone entend`, 'ok');
}

function dire(texte, ton = 'neutre') {
  lec.etat.textContent = texte;
  lec.etat.dataset.ton = ton;
}
