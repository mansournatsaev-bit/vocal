// Page téléphone : l'appel avec l'ordinateur démarre dès l'ouverture du lien, et le micro
// est enregistré en continu. Chaque appui sur le gros bouton envoie le morceau depuis l'appui précédent.

const $ = sel => document.querySelector(sel);
const el = {
  etat: $('#etat'), etatTexte: $('#etat-texte'), chrono: $('#chrono'), raccrocher: $('#raccrocher'),
  niveau: $('#niveau'), niveauOrdi: $('#niveau-ordi'), alerte: $('#alerte'),
  journal: $('#journal'), liste: $('#liste'), voile: $('#voile'), telecommande: $('#telecommande'),
  ecranNoir: $('#ecran-noir'), volume: $('#volume'), volumeValeur: $('#volume-valeur'),
  volumeCurseur: $('#volume-curseur'), volumeMoins: $('#volume-moins'), volumePlus: $('#volume-plus'),
  bouton: $('#gros-bouton'), boutonTitre: $('#bouton-titre'), boutonSous: $('#bouton-sous'),
  son: $('#son-distant'),
  photo: $('#photo'), camera: $('#camera'), cameraVideo: $('#camera-video'), cameraCadre: $('#camera-cadre'),
  cameraApercu: $('#camera-apercu'), cameraAide: $('#camera-aide'),
  cameraBarrePrise: $('#camera-barre-prise'), cameraBarreEnvoi: $('#camera-barre-envoi'),
  cameraAnnuler: $('#camera-annuler'), cameraPrendre: $('#camera-prendre'),
  cameraReprendre: $('#camera-reprendre'), cameraScan: $('#camera-scan'), cameraEnvoyer: $('#camera-envoyer'),
};

// Présent quand la page tourne dans l'appli Android : elle gère les boutons de volume et l'écran noir.
const natif = window.VocalNatif || null;

const base = new Base('vocal-telephone');
const attente = [];          // vocaux et photos pas encore confirmés par l'ordinateur, du plus ancien au plus récent
const donnees = new Map();   // id → fichier (ArrayBuffer : WAV ou JPEG) préparé pendant cette session
const accuses = new Map();   // id → fonction appelée quand l'ordinateur confirme la réception
const lignes = new Map();    // id → <li> du journal

let micro = null, ctx = null, lecteurMicro = null, tauxEch = 48000;
let enAppel = false, demarrage = false, microCoupe = false, erreurMicro = '';
let morceaux = [], frames = 0, crete = 0, creteOrdi = 0, dernierPCM = 0, debutSegment = 0, debutAppel = 0;
let perduSegment = 0;        // secondes de micro manquantes dans le segment en cours (remplacées par du silence)
let peer = null, conn = null, appel = null, tentative = null;
let appelOk = false, appelDepuis = 0, dernierSigne = 0, connDepuis = 0, idPrisLe = 0, injoignableLe = 0;
let envoiEnCours = false, gardien = null, horloge = null, veille = null;
let silence = null, sonsCtx = null, dernierAppuiDistant = 0;  // bouton des écouteurs

jalon('Page prête');
chargerAttente();
// Connexion au serveur et demande du micro en parallèle : l'appel s'établit plus vite.
if (window.Peer) demarrerReseau();
demarrer();

el.bouton.addEventListener('click', () => (enAppel ? envoyer() : demarrer()));
el.raccrocher.addEventListener('click', () => raccrocher());
el.ecranNoir.addEventListener('click', () => natif?.ecranNoir());
el.photo.addEventListener('click', ouvrirCamera);
el.cameraAnnuler.addEventListener('click', fermerCamera);
el.cameraPrendre.addEventListener('click', prendrePhoto);
el.cameraReprendre.addEventListener('click', reprendrePhoto);
el.cameraScan.addEventListener('click', basculerScan);
el.cameraEnvoyer.addEventListener('click', envoyerPhoto);
// Appelée par l'appli Android quand on appuie sur un bouton de volume.
window.vocalEnvoyer = envoyerDepuisBouton;

// Dans l'appli, les boutons de volume envoient le vocal : le volume se règle ici, au milieu de l'écran.
// De 0 à 100 % : volume normal du téléphone. De 100 à 150 % : téléphone au maximum, et l'appli
// amplifie en plus le son de l'appel (avec un limiteur contre la saturation).
const AMPLI_MAX = 1.5;
let ampli = Math.min(AMPLI_MAX, Math.max(1, Number(memo.lire('ampli')) || 1));
let ampliSource = null, ampliGain = null;

if (natif && natif.volume) {
  el.volume.hidden = false;
  afficherVolume(natif.volume());
  el.volumeCurseur.addEventListener('input', () => {
    const v = Number(el.volumeCurseur.value);
    reglerAmpli(v);
    const reel = natif.reglerVolume(Math.min(v, 100));
    el.volumeValeur.textContent = (v > 100 ? v : reel) + ' %';
    el.volumeCurseur.style.setProperty('--rempli', v / AMPLI_MAX + '%');
  });
  el.volumeCurseur.addEventListener('change', () => afficherVolume(natif.volume()));
  el.volumeMoins.addEventListener('click', () => {
    if (ampli > 1) {
      reglerAmpli(Math.round(ampli * 100) - 10);
      afficherVolume(natif.volume());
    } else afficherVolume(natif.changerVolume(-1));
  });
  el.volumePlus.addEventListener('click', () => {
    const actuel = natif.volume();
    if (actuel >= 100) {
      reglerAmpli(Math.round(ampli * 100) + 10);
      afficherVolume(actuel);
    } else afficherVolume(natif.changerVolume(1));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') afficherVolume(natif.volume());
  });
}

function afficherVolume(pourcent) {
  const v = pourcent >= 100 ? Math.round(ampli * 100) : pourcent;
  el.volumeCurseur.value = v;
  el.volumeCurseur.style.setProperty('--rempli', v / AMPLI_MAX + '%');
  el.volumeValeur.textContent = v + ' %';
}

// pourcent ≤ 100 : pas d'amplification.
function reglerAmpli(pourcent) {
  ampli = Math.min(AMPLI_MAX, Math.max(1, pourcent / 100));
  memo.ecrire('ampli', ampli);
  majAmpli();
}

// Au-delà de 100 %, le son de l'appel passe par l'amplificateur ; l'élément audio, muet, garde le
// flux en vie (Chrome ne fait rien sortir d'un flux d'appel qui n'est attaché à aucun élément).
function majAmpli() {
  const flux = el.son.srcObject;
  if (ampli <= 1 || !flux) {
    ampliSource?.disconnect();
    ampliSource = null;
    el.son.muted = false;
    return;
  }
  try {
    if (!sonsCtx) sonsCtx = new AudioContext();
    sonsCtx.resume();
    if (!ampliGain) {
      ampliGain = sonsCtx.createGain();
      const limiteur = sonsCtx.createDynamicsCompressor();
      limiteur.threshold.value = -3;
      limiteur.knee.value = 0;
      limiteur.ratio.value = 20;
      limiteur.attack.value = 0.002;
      limiteur.release.value = 0.1;
      ampliGain.connect(limiteur).connect(sonsCtx.destination);
    }
    ampliGain.gain.value = ampli;
    if (!ampliSource || ampliSource.mediaStream !== flux) {
      ampliSource?.disconnect();
      ampliSource = sonsCtx.createMediaStreamSource(flux);
      ampliSource.connect(ampliGain);
    }
    el.son.muted = true;
  } catch (e) {
    console.warn('Amplificateur indisponible', e);
    el.son.muted = false;
  }
}

// Dans l'appli, raccrocher rend le téléphone muet (multimédia à 0, sonnerie et notifications coupées) ;
// l'appel revient avec le son d'avant.
function remettreSon() {
  if (!natif || !natif.remettreSon) return;
  natif.remettreSon();
  if (natif.volume) afficherVolume(natif.volume());
}

// Les navigateurs coupent le son tant qu'on n'a pas touché la page : le premier toucher le débloque.
document.addEventListener('pointerdown', () => {
  ctx?.resume();
  if (el.son.srcObject && el.son.paused) el.son.play().then(rafraichir).catch(() => {});
  if (!sonsCtx) sonsCtx = new AudioContext();
  sonsCtx.resume();
  if (enAppel) activerTelecommande();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !enAppel) return;
  garderEcranAllume();
  ctx?.resume();
});

addEventListener('beforeunload', e => {
  if ((enAppel && frames > tauxEch * 2) || attente.length) { e.preventDefault(); e.returnValue = ''; }
});

async function chargerAttente() {
  const restants = (await base.tout()).sort((a, b) => a.debut - b.debut);
  for (const { wav, fichier, ...v } of restants) {
    attente.push(v);
    ligne(v, 'En attente', 'attente');
  }
  if (attente.length) demarrerReseau();
  majEtat();
}

// ---------- Micro et enregistrement ----------

async function demarrer() {
  if (enAppel || demarrage) return;
  demarrage = true;
  remettreSon();
  erreurMicro = '';
  el.bouton.disabled = true;
  el.boutonTitre.textContent = 'Envoyer';
  el.boutonSous.textContent = 'Autorise le micro pour commencer';
  majEtat();
  try {
    if (!window.Peer) throw new Error('vérifie la connexion internet puis recharge la page');
    console.info(`Démarrage : demande du micro (page ${document.visibilityState})`);
    micro = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    jalon('Micro obtenu');
    await brancherCapture(micro.getAudioTracks()[0]);
  } catch (e) {
    console.info(`Démarrage impossible : ${e.name} ${e.message}`);
    arreterMicro();
    demarrage = false;
    erreurMicro = e.name === 'NotAllowedError' ? 'Micro refusé' : 'Micro indisponible';
    el.bouton.disabled = false;
    el.boutonTitre.textContent = 'Réessayer';
    el.boutonSous.textContent = e.name === 'NotAllowedError'
      ? 'Autorise le micro (icône à gauche de l\'adresse), puis touche ici'
      : e.message;
    return majEtat();
  }

  micro.getAudioTracks()[0].addEventListener('ended', () => { microCoupe = true; });
  demarrage = false;
  enAppel = true;
  microCoupe = false;
  morceaux = [];
  frames = 0;
  perduSegment = 0;
  dernierPCM = debutSegment = debutAppel = Date.now();

  el.raccrocher.hidden = false;
  el.bouton.disabled = false;
  garderEcranAllume();
  activerTelecommande();
  if (natif) {
    el.telecommande.textContent = '🔊 Les boutons de volume envoient le vocal (bip-bip = envoyé).';
    el.telecommande.hidden = false;
    el.ecranNoir.hidden = false;
  }
  clearInterval(horloge);
  horloge = setInterval(rafraichir, 100);
  demarrerReseau();
  if (liaisonOuverte()) lancerAppel();  // l'ordinateur était déjà relié pendant la demande du micro
  rafraichir();
}

// Étapes du démarrage, avec le temps écoulé depuis l'ouverture de la page (journal de l'appli).
function jalon(texte) {
  console.info(`${texte} (${Math.round(performance.now())} ms)`);
}

// Capture brute du micro. Chrome lit la piste directement, sans attendre de toucher l'écran ;
// sinon on passe par un AudioWorklet, que le navigateur peut laisser en pause jusqu'au premier toucher.
async function brancherCapture(piste) {
  if (window.MediaStreamTrackProcessor) {
    lecteurMicro = new MediaStreamTrackProcessor({ track: piste, maxBufferSize: 3000 }).readable.getReader();
    lireMicro(lecteurMicro);
    return;
  }
  ctx = new AudioContext();
  tauxEch = ctx.sampleRate;
  await ctx.audioWorklet.addModule('capture-worklet.js');
  const capteur = new AudioWorkletNode(ctx, 'capture');
  capteur.port.onmessage = e => recevoirPCM(e.data);
  ctx.createMediaStreamSource(micro).connect(capteur).connect(ctx.destination);
  ctx.resume();  // sans await : sans toucher d'écran, la promesse peut attendre longtemps
}

async function lireMicro(lecteur) {
  let prochain = null;  // horodatage attendu de la trame suivante (µs)
  for (;;) {
    let r;
    try { r = await lecteur.read(); } catch { return; }
    if (r.done) return;
    const trame = r.value;
    tauxEch = trame.sampleRate;
    // Trou dans le micro (page ralentie écran éteint, par exemple) : on le comble avec du silence
    // pour garder la bonne durée, et on le compte pour l'afficher.
    if (prochain !== null) {
      const trou = (trame.timestamp - prochain) / 1e6;
      if (trou > 0.05) {
        recevoirPCM(new Int16Array(Math.round(Math.min(trou, 300) * tauxEch)));
        perduSegment += trou;
      }
    }
    prochain = trame.timestamp + trame.duration;
    recevoirPCM(versInt16(trame));
    trame.close();
  }
}

// Premier canal d'une trame audio, en PCM 16 bits.
function versInt16(trame) {
  const n = trame.numberOfFrames, canaux = trame.numberOfChannels;
  const f32 = new Float32Array(n);
  if (trame.format === 'f32-planar') {
    trame.copyTo(f32, { planeIndex: 0 });
  } else if (trame.format === 'f32') {
    const entrelace = new Float32Array(n * canaux);
    trame.copyTo(entrelace, { planeIndex: 0 });
    for (let i = 0; i < n; i++) f32[i] = entrelace[i * canaux];
  } else {
    trame.copyTo(f32, { planeIndex: 0, format: 'f32-planar' });
  }
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

// Envoi automatique toutes les 3 minutes sans appui. La coupure tombe entre deux morceaux reçus du
// micro : rien n'est perdu, le morceau suivant ouvre le vocal suivant.
const DUREE_MAX = 3 * 60;  // s

function recevoirPCM(pcm) {
  if (!enAppel) return;
  morceaux.push(pcm);
  frames += pcm.length;
  dernierPCM = Date.now();
  for (let i = 0; i < pcm.length; i += 8) {
    const v = Math.abs(pcm[i]);
    if (v > crete) crete = v;
  }
  if (frames >= tauxEch * DUREE_MAX) {
    console.info('3 minutes sans envoi : envoi automatique');
    envoyer();
  }
}

function rafraichir() {
  if (!enAppel) return;
  el.boutonSous.textContent = `${duree(frames / tauxEch)} à envoyer`;
  el.chrono.textContent = duree((Date.now() - debutAppel) / 1000);
  el.niveau.style.transform = `scaleX(${largeurNiveau(crete / 32768)})`;
  el.niveauOrdi.style.transform = `scaleX(${largeurNiveau(creteOrdi)})`;
  crete = creteOrdi = 0;

  let alerte = '';
  if (microCoupe) alerte = 'Le micro a été coupé par le téléphone. Raccroche puis touche « Rappeler ».';
  else if (ctx && ctx.state !== 'running') alerte = 'Touche l\'écran pour lancer l\'enregistrement.';
  else if (Date.now() - dernierPCM > 1500) alerte = 'Micro en pause : garde l\'appli au premier plan.';
  el.alerte.hidden = !alerte;
  el.alerte.textContent = alerte;
  el.voile.hidden = !(el.son.srcObject && el.son.paused);
}

async function envoyer() {
  const sr = tauxEch;
  if (frames < sr * 0.5) return flash('Trop court', 'refus');

  const pcm = morceaux, n = frames, debut = debutSegment, perdu = perduSegment;
  morceaux = [];
  frames = 0;
  perduSegment = 0;
  debutSegment = Date.now();
  flash('Envoyé ✓', 'envoye');
  if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(40);

  const numero = Number(memo.lire('vocal-num') || 0) + 1;
  memo.ecrire('vocal-num', numero);
  majTelecommande(`Vocal ${numero} envoyé ✓`);
  const v = { id: nouvelId(), numero, debut, duree: n / sr, perdu, nom: nomFichier(numero, debut) };
  const wav = encoderWav(pcm, n, sr);
  donnees.set(v.id, wav);
  try { await base.mettre({ ...v, fichier: wav }); } catch (e) { console.warn('Sauvegarde locale impossible', e); }

  attente.push(v);
  ligne(v, 'En attente', 'attente');
  pomper();
}

function encoderWav(pcm, n, sr) {
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const texte = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  texte(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); texte(8, 'WAVE');
  texte(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  texte(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const m of pcm) {
    new Int16Array(buf, o, m.length).set(m);
    o += m.length * 2;
  }
  return buf;
}

// sansQuestion : depuis les boutons physiques (écran souvent éteint), le reste est envoyé sans demander.
async function raccrocher({ sansQuestion = false } = {}) {
  if (!enAppel) return;
  const reste = frames / tauxEch;
  if (reste >= 0.5 && (sansQuestion || confirm(`Envoyer les ${duree(reste)} pas encore envoyées ?`))) await envoyer();

  enAppel = false;
  envoyerMsg(conn, { t: 'raccroche' });
  couperAppel();
  arreterMicro();
  desactiverTelecommande();
  clearInterval(horloge);
  veille?.release().catch(() => {});
  veille = null;

  el.raccrocher.hidden = true;
  el.alerte.hidden = true;
  el.voile.hidden = true;
  el.telecommande.hidden = true;
  el.ecranNoir.hidden = true;
  el.chrono.textContent = '';
  el.niveau.style.transform = el.niveauOrdi.style.transform = 'scaleX(0)';
  el.boutonTitre.textContent = 'Rappeler';
  el.boutonSous.textContent = 'Touche pour reprendre l\'appel';
  verifierFin();
  // Muet une fois le son de fin d'appel joué.
  if (natif && natif.couperSon) natif.couperSon(900);
}

function arreterMicro() {
  lecteurMicro?.cancel().catch(() => {});
  lecteurMicro = null;
  micro?.getTracks().forEach(t => t.stop());
  micro = null;
  ctx?.close().catch(() => {});
  ctx = null;
}

async function garderEcranAllume() {
  try { veille = await navigator.wakeLock?.request('screen'); } catch {}
}

// ---------- Bouton des écouteurs ----------
// Le bouton pause/lecture des écouteurs (et celui de l'écran de verrouillage) envoie le vocal.
// Chrome ne transmet ces boutons qu'à une page qui joue un média : on joue donc un silence en boucle.

function activerTelecommande() {
  if (natif || !('mediaSession' in navigator) || silence) return;
  const blanc = encoderWav([new Int16Array(8000 * 10)], 8000 * 10, 8000);
  silence = new Audio(URL.createObjectURL(new Blob([blanc], { type: 'audio/wav' })));
  silence.loop = true;
  silence.play().then(() => {
    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack']) {
      try { navigator.mediaSession.setActionHandler(action, appuiDistant); } catch {}
    }
    majTelecommande('Appel en cours');
    el.telecommande.hidden = false;
  }).catch(() => {
    // Lecture refusée tant que la page n'a pas été touchée : on réessaiera au premier toucher.
    URL.revokeObjectURL(silence.src);
    silence = null;
  });
}

function desactiverTelecommande() {
  if (!silence) return;
  silence.pause();
  URL.revokeObjectURL(silence.src);
  silence = null;
  for (const action of ['play', 'pause', 'nexttrack', 'previoustrack']) {
    try { navigator.mediaSession.setActionHandler(action, null); } catch {}
  }
  navigator.mediaSession.playbackState = 'none';
  el.telecommande.hidden = true;
}

function majTelecommande(titre) {
  if (!silence) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: titre,
    artist: 'Bouton des écouteurs : envoyer le vocal',
    artwork: [{ src: 'icone.svg', sizes: '512x512', type: 'image/svg+xml' }],
  });
  navigator.mediaSession.playbackState = 'playing';
}

function appuiDistant() {
  // Le silence doit continuer à jouer, sinon Chrome ne nous transmet plus le bouton.
  if (silence?.paused) silence.play().catch(() => {});
  navigator.mediaSession.playbackState = 'playing';
  envoyerDepuisBouton();
}

// Bouton physique (volume dans l'appli, ou écouteurs) :
// - un appui envoie le vocal, comme le gros bouton ;
// - deux appuis rapides raccrochent, ou rappellent si l'appel est coupé.
// Le premier des deux appuis a déjà envoyé le vocal, donc rien n'est perdu en raccrochant.
// Renvoie ce qui s'est passé, que l'appli Android note dans son journal.
const DOUBLE_APPUI = 500;  // ms maximum entre les deux appuis

function envoyerDepuisBouton() {
  const maintenant = Date.now();
  const double = maintenant - dernierAppuiDistant < DOUBLE_APPUI;
  dernierAppuiDistant = double ? 0 : maintenant;  // un troisième appui repart de zéro

  if (double) {
    if (enAppel) {
      raccrocher({ sansQuestion: true });
      jouerNotes(SON_RACCROCHE);
      return 'raccroché';
    }
    if (demarrage) return 'rappel déjà en cours (micro en attente)';
    remettreSon();  // avant le son de rappel, pour qu'il s'entende
    jouerNotes(SON_RAPPEL);
    // Restée longtemps cachée, cette page n'obtient plus le micro : l'appli la remplace par une neuve,
    // qui démarre l'appel tout de suite.
    if (natif && natif.relancer) {
      natif.relancer();
      return 'rappel (nouvelle page)';
    }
    demarrer();
    return 'rappel';
  }

  if (!enAppel) {
    jouerNotes(SON_RIEN);
    return 'pas en appel (deux appuis rapides pour rappeler)';
  }
  const secondes = frames / tauxEch;
  const assezLong = secondes >= 0.5;
  envoyer();
  jouerNotes(assezLong ? SON_ENVOYE : SON_RIEN);
  return `${assezLong ? 'envoyé' : 'trop court'} : ${secondes.toFixed(1)} s, page ${document.visibilityState}, ` +
    `liaison ${liaisonOuverte() ? 'ouverte' : 'fermée'}`;
}

// Signaux dans les écouteurs, pour savoir ce qui s'est passé sans regarder l'écran.
const SON_ENVOYE = { notes: [880, 1320], ecart: 0.12 };        // deux notes aiguës
const SON_RIEN = { notes: [330], ecart: 0.12 };                // une note grave : rien envoyé
const SON_RACCROCHE = { notes: [660, 440, 220], ecart: 0.18 }; // trois notes qui descendent
const SON_RAPPEL = { notes: [440, 660, 880], ecart: 0.18 };    // trois notes qui montent

function jouerNotes({ notes, ecart }) {
  try {
    if (!sonsCtx) sonsCtx = new AudioContext();
    sonsCtx.resume();
    const t = sonsCtx.currentTime;
    notes.forEach((frequence, i) => {
      const o = sonsCtx.createOscillator(), g = sonsCtx.createGain();
      const debut = t + i * ecart, duree = ecart - 0.02;
      o.frequency.value = frequence;
      g.gain.setValueAtTime(0.0001, debut);
      g.gain.exponentialRampToValueAtTime(0.12, debut + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, debut + duree);
      o.connect(g).connect(sonsCtx.destination);
      o.start(debut);
      o.stop(debut + duree + 0.01);
    });
  } catch {}
}

// ---------- Photo d'une feuille ----------
// Appareil photo dans la page, en mode document : caméra arrière en pleine définition, cadre A4 pour
// viser, puis traitement « scan » (papier blanc, ombres effacées, texte foncé) avant l'envoi.
// Jamais de flash ni de lampe : ils font des reflets sur le papier.

const PHOTO_COTE_MAX = 3200;  // px : largement assez pour lire une feuille A4, et léger à envoyer en 4G
let camera = null, capteurPhoto = null;
let photoBrute = null, photoScan = null, scanActif = true;  // { blob, url }

async function ouvrirCamera() {
  el.camera.hidden = false;
  montrerViseur();
  try {
    camera = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
    });
  } catch (e) {
    el.cameraPrendre.disabled = true;
    el.cameraAide.textContent = e.name === 'NotAllowedError'
      ? 'Caméra refusée : autorise-la dans les réglages, puis réessaie.'
      : 'Caméra indisponible : ' + e.message;
    return;
  }
  const piste = camera.getVideoTracks()[0];
  // Lampe éteinte, puis mise au point, exposition et blancs en continu : le texte reste net si la
  // feuille bouge un peu.
  const capacites = piste.getCapabilities ? piste.getCapabilities() : {};
  try {
    if (capacites.torch) await piste.applyConstraints({ advanced: [{ torch: false }] });
  } catch {}
  try {
    await piste.applyConstraints({
      advanced: [{ focusMode: 'continuous' }, { exposureMode: 'continuous' }, { whiteBalanceMode: 'continuous' }],
    });
  } catch {}
  el.cameraVideo.srcObject = camera;
  capteurPhoto = window.ImageCapture ? new ImageCapture(piste) : null;
  const reglages = piste.getSettings();
  console.info(`Caméra ouverte : ${reglages.width}×${reglages.height}`);
}

function fermerCamera() {
  camera?.getTracks().forEach(t => t.stop());
  camera = capteurPhoto = null;
  el.cameraVideo.srcObject = null;
  oublierPhoto();
  el.camera.hidden = true;
}

function montrerViseur() {
  el.cameraVideo.hidden = el.cameraCadre.hidden = el.cameraBarrePrise.hidden = false;
  el.cameraApercu.hidden = el.cameraBarreEnvoi.hidden = true;
  el.cameraPrendre.disabled = false;
  el.cameraAide.textContent = 'Cadre toute la feuille, bien à plat et éclairée';
}

async function prendrePhoto() {
  if (!camera) return;
  el.cameraPrendre.disabled = true;
  el.cameraAide.textContent = 'Photo…';
  let image = null;
  // Pleine définition du capteur, flash forcé sur « off ». Si le téléphone a un flash qu'on ne peut pas
  // forcer à « off », pas de photo pleine définition : l'image du viseur, elle, ne déclenche jamais le flash.
  if (capteurPhoto) {
    try {
      const possibles = await capteurPhoto.getPhotoCapabilities();
      const flashs = possibles.fillLightMode || [];
      if (flashs.length && !flashs.includes('off')) throw new Error('flash impossible à couper');
      const options = { imageWidth: possibles.imageWidth.max, imageHeight: possibles.imageHeight.max };
      if (flashs.length) options.fillLightMode = 'off';
      image = await createImageBitmap(await capteurPhoto.takePhoto(options), { imageOrientation: 'from-image' });
    } catch (e) {
      console.info(`Photo pleine définition impossible (${e.message}) : image du viseur`);
    }
  }
  if (!image) image = await createImageBitmap(el.cameraVideo);
  el.cameraAide.textContent = 'Amélioration du texte…';
  await new Promise(r => setTimeout(r, 30));  // laisse l'écran afficher le message avant le calcul
  const toile = reduire(image, PHOTO_COTE_MAX);
  image.close();
  photoBrute = await enJpeg(toile);
  ameliorerDocument(toile);
  photoScan = await enJpeg(toile);
  scanActif = true;
  console.info(`Photo : ${toile.width}×${toile.height}, ${(photoScan.blob.size / 1048576).toFixed(1)} Mo`);
  montrerApercu();
}

function montrerApercu() {
  el.cameraVideo.hidden = el.cameraCadre.hidden = el.cameraBarrePrise.hidden = true;
  el.cameraApercu.hidden = el.cameraBarreEnvoi.hidden = false;
  el.cameraApercu.src = (scanActif ? photoScan : photoBrute).url;
  el.cameraScan.setAttribute('aria-pressed', String(scanActif));
  el.cameraScan.textContent = scanActif ? 'Texte net' : 'Original';
  el.cameraEnvoyer.disabled = false;
  el.cameraAide.textContent = 'Vérifie que le texte est lisible';
}

function basculerScan() {
  scanActif = !scanActif;
  montrerApercu();
}

function reprendrePhoto() {
  oublierPhoto();
  montrerViseur();
}

function oublierPhoto() {
  for (const p of [photoBrute, photoScan]) if (p) URL.revokeObjectURL(p.url);
  photoBrute = photoScan = null;
  el.cameraApercu.removeAttribute('src');
}

async function envoyerPhoto() {
  const choisie = scanActif ? photoScan : photoBrute;
  if (!choisie) return;
  el.cameraEnvoyer.disabled = true;
  const numero = Number(memo.lire('photo-num') || 0) + 1;
  memo.ecrire('photo-num', numero);
  const maintenant = Date.now();
  const v = { id: nouvelId(), type: 'photo', numero, debut: maintenant, duree: 0, nom: nomFichier(numero, maintenant, 'photo') };
  const fichier = await choisie.blob.arrayBuffer();
  donnees.set(v.id, fichier);
  try { await base.mettre({ ...v, fichier }); } catch (e) { console.warn('Sauvegarde locale impossible', e); }
  attente.push(v);
  ligne(v, 'En attente', 'attente');
  jouerNotes(SON_ENVOYE);
  fermerCamera();
  if (window.Peer) demarrerReseau();  // la photo part aussi quand l'appel est raccroché
  pomper();
}

function reduire(image, coteMax) {
  const echelle = Math.min(1, coteMax / Math.max(image.width, image.height));
  const toile = document.createElement('canvas');
  toile.width = Math.round(image.width * echelle);
  toile.height = Math.round(image.height * echelle);
  const c = toile.getContext('2d', { willReadFrequently: true });
  c.imageSmoothingQuality = 'high';
  c.drawImage(image, 0, 0, toile.width, toile.height);
  return toile;
}

function enJpeg(toile) {
  return new Promise(ok => toile.toBlob(blob => ok({ blob, url: URL.createObjectURL(blob) }), 'image/jpeg', 0.9));
}

// Traitement « scan » : on estime la couleur du papier en chaque point (image réduite où le texte est
// effacé par un maximum local), puis on divise par ce fond. Le papier devient blanc partout, ombres et
// dégradés compris, et le texte garde sa couleur, en plus foncé.
function ameliorerDocument(toile) {
  const w = toile.width, h = toile.height;
  const c = toile.getContext('2d', { willReadFrequently: true });
  const petite = document.createElement('canvas');
  petite.width = Math.max(8, Math.round(w / 32));
  petite.height = Math.max(8, Math.round(h / 32));
  const pc = petite.getContext('2d', { willReadFrequently: true });
  pc.drawImage(toile, 0, 0, petite.width, petite.height);
  const reduite = pc.getImageData(0, 0, petite.width, petite.height);
  maximumLocal(reduite, 3);
  pc.putImageData(reduite, 0, 0);

  const fond = document.createElement('canvas');
  fond.width = w;
  fond.height = h;
  const fc = fond.getContext('2d', { willReadFrequently: true });
  fc.imageSmoothingQuality = 'high';
  fc.drawImage(petite, 0, 0, w, h);

  const image = c.getImageData(0, 0, w, h);
  const p = image.data, f = fc.getImageData(0, 0, w, h).data;
  for (let i = 0; i < p.length; i += 4) {
    for (let k = i; k < i + 3; k++) {
      const v = (p[k] / (f[k] || 1) - 0.08) / 0.84;  // 1 = papier : il sature en blanc
      p[k] = v <= 0 ? 0 : v >= 1 ? 255 : 255 * v * Math.sqrt(v);  // v^1,5 : texte plus foncé
    }
  }
  c.putImageData(image, 0, 0);
}

// Maximum sur un carré de (2r+1)² pixels, canal par canal : efface le texte, garde le papier.
function maximumLocal(img, r) {
  const { width: w, height: h, data } = img;
  const tmp = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 3; k++) {
        let m = 0;
        for (let d = -r; d <= r; d++) m = Math.max(m, data[(y * w + Math.min(w - 1, Math.max(0, x + d))) * 4 + k]);
        tmp[(y * w + x) * 4 + k] = m;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 3; k++) {
        let m = 0;
        for (let d = -r; d <= r; d++) m = Math.max(m, tmp[(Math.min(h - 1, Math.max(0, y + d)) * w + x) * 4 + k]);
        data[(y * w + x) * 4 + k] = m;
      }
    }
  }
}

// ---------- Réseau : liaison de données + appel ----------

function demarrerReseau() {
  if (!peer || peer.destroyed) {
    peer = new Peer(ID_TELEPHONE, optionsPeer());
    peer.on('open', () => {
      jalon('Serveur connecté');
      surveiller();
    });
    peer.on('disconnected', majEtat);
    peer.on('error', erreurPeer);
    peer.on('connection', accepter);
  }
  if (!gardien) gardien = setInterval(surveiller, 3000);
}

function erreurPeer(err) {
  if (err.type === 'peer-unavailable') {
    // L'ordinateur n'a pas encore ouvert la page : on réessaie au prochain tour.
    tentative?.close();
    tentative = null;
  } else if (err.type === 'unavailable-id') {
    idPrisLe = Date.now();
  } else {
    console.warn('PeerJS', err.type, err);
  }
  majEtat();
}

function liaisonOuverte() {
  return !!(conn && conn.open);
}

// Toutes les 3 s : reconnexion au serveur, appel de l'ordinateur, battement de cœur, reprise des envois.
function surveiller() {
  // PeerJS détruit la connexion si la place est encore prise à l'ouverture (rechargement rapide) :
  // on en recrée une tant qu'on a un appel ou des vocaux à envoyer.
  if (!peer || peer.destroyed) {
    if (enAppel || demarrage || attente.length) demarrerReseau();
    return;
  }
  if (peer.disconnected) {
    try { peer.reconnect(); } catch {}
  } else if (peer.open) {
    if (!liaisonOuverte()) {
      if (conn) debrancher();
      essayerConnexion();
    } else if (Date.now() - dernierSigne > DELAI_SILENCE) {
      const c = conn;
      c.close();
      if (conn === c) debrancher();
    } else {
      envoyerMsg(conn, { t: 'ping' });
      if (enAppel && !appel) lancerAppel();
      else if (appel && !appelOk && Date.now() - appelDepuis > 15000) couperAppel();
      if (attente.length && !envoiEnCours) pomper();
    }
  }
  majEtat();
}

function essayerConnexion() {
  if (tentative || liaisonOuverte() || !peer?.open) return;
  const c = tentative = peer.connect(ID_ORDI, { serialization: 'raw', reliable: true });
  surveillerIce(c);
  // En 4G, passer par un relais peut prendre plusieurs secondes : on laisse 15 s à la tentative.
  const abandon = setTimeout(() => {
    if (!c.open) c.close();
    if (tentative === c) tentative = null;
  }, 15000);
  c.on('open', () => {
    clearTimeout(abandon);
    if (tentative === c) tentative = null;
    brancher(c);
  });
  c.on('close', () => {
    clearTimeout(abandon);
    if (tentative === c) tentative = null;
    if (conn === c) debrancher();
  });
  c.on('error', e => console.warn('Liaison', e));
}

// L'ordinateur essaie aussi de nous joindre quand il arrive : c'est le téléphone qui choisit
// la liaison gardée. Si notre liaison vient de s'ouvrir, les deux côtés se sont appelés en même
// temps et on garde la nôtre ; sinon c'est une nouvelle page d'ordinateur qui remplace l'ancienne.
function accepter(c) {
  surveillerIce(c);
  c.on('open', () => {
    if (liaisonOuverte() && Date.now() - connDepuis < 5000) return c.close();
    tentative?.close();
    tentative = null;
    brancher(c);
  });
  c.on('close', () => { if (conn === c) debrancher(); });
  c.on('error', e => console.warn('Liaison', e));
}

// L'ordinateur est en ligne mais impossible à joindre depuis ce réseau (4G sans relais, pare-feu…).
function surveillerIce(c) {
  const pc = c.peerConnection;
  if (!pc) return;
  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState !== 'failed') return;
    injoignableLe = Date.now();
    jalon('Ordinateur injoignable depuis ce réseau');
    majEtat();
  });
}

function brancher(c) {
  if (conn && conn !== c) conn.close();
  conn = c;
  dernierSigne = connDepuis = Date.now();
  injoignableLe = 0;
  jalon("Liaison avec l'ordinateur ouverte");
  c.on('data', d => {
    if (conn !== c) return;
    dernierSigne = Date.now();
    if (typeof d !== 'string') return;
    let m;
    try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'recu') accuses.get(m.id)?.();
  });
  // Nouvelle liaison = nouvel appel : l'ancien a pu mourir avec l'ancienne page de l'ordinateur.
  couperAppel();
  if (enAppel) lancerAppel();
  majEtat();
  pomper();
}

function debrancher() {
  conn = null;
  couperAppel();
}

function lancerAppel() {
  if (appel || !micro || !peer?.open) return;
  const a = peer.call(ID_ORDI, micro, { sdpTransform: opusHauteQualite });
  if (!a) return;
  appel = a;
  appelOk = false;
  appelDepuis = Date.now();
  a.on('stream', flux => {
    if (appel !== a || el.son.srcObject === flux) return;
    appelOk = true;
    jalon('Appel audio établi');
    el.son.srcObject = flux;
    el.son.play().catch(() => {});
    majAmpli();
    suivreNiveau(flux.getAudioTracks()[0], c => { if (appel === a && c > creteOrdi) creteOrdi = c; });
    majEtat();
  });
  a.on('close', () => { if (appel === a) couperAppel(); });
  a.on('error', () => { if (appel === a) couperAppel(); });
}

function couperAppel() {
  const a = appel;
  appel = null;
  appelOk = false;
  a?.close();
  el.son.srcObject = null;
  majAmpli();
  majEtat();
}

// ---------- Envoi des vocaux ----------

async function pomper() {
  if (envoiEnCours) return;
  envoiEnCours = true;
  try {
    while (attente.length && liaisonOuverte()) {
      const v = attente[0];
      const stocke = donnees.has(v.id) ? null : await base.lire(v.id);
      const wav = donnees.get(v.id) || stocke?.fichier || stocke?.wav;  // « wav » : vocaux stockés avant les photos
      if (wav && !(await transmettre(v, wav))) {
        ligne(v, 'En attente', 'attente');
        break;
      }
      attente.shift();
      donnees.delete(v.id);
      await base.suppr(v.id).catch(() => {});
      ligne(v, wav ? 'Reçu ✓' : 'Perdu', wav ? 'ok' : 'erreur');
    }
  } finally {
    envoiEnCours = false;
    verifierFin();
  }
}

// Envoie un vocal par paquets et attend l'accusé de réception de l'ordinateur.
async function transmettre(v, wav) {
  const c = conn, canal = c.dataChannel;
  let pourcent = -1;
  envoyerMsg(c, {
    t: 'debut', id: v.id, type: v.type || 'vocal', numero: v.numero, debut: v.debut, duree: v.duree,
    nom: v.nom, taille: wav.byteLength,
  });
  for (let o = 0; o < wav.byteLength; o += TAILLE_MORCEAU) {
    if (conn !== c || !c.open) return false;
    c.send(wav.slice(o, o + TAILLE_MORCEAU));
    if (canal && canal.bufferedAmount > 256 * 1024) await vidange(canal);
    const p = Math.floor((o / wav.byteLength) * 100);
    if (p !== pourcent) ligne(v, `Envoi ${(pourcent = p)} %`, 'envoi');
  }
  const accuse = new Promise(ok => {
    const fin = valeur => { clearTimeout(delai); clearInterval(veilleur); accuses.delete(v.id); ok(valeur); };
    const delai = setTimeout(() => fin(false), 30000);
    const veilleur = setInterval(() => { if (conn !== c) fin(false); }, 500);
    accuses.set(v.id, () => fin(true));
  });
  envoyerMsg(c, { t: 'fin', id: v.id });
  return accuse;
}

function vidange(canal) {
  return new Promise(ok => {
    canal.bufferedAmountLowThreshold = 64 * 1024;
    const fin = () => { canal.removeEventListener('bufferedamountlow', fin); clearTimeout(delai); ok(); };
    const delai = setTimeout(fin, 1000);
    canal.addEventListener('bufferedamountlow', fin);
  });
}

// Une fois raccroché et tout envoyé, on libère la connexion.
function verifierFin() {
  majEtat();
  if (enAppel || demarrage || attente.length || !peer) return;
  setTimeout(() => {
    if (enAppel || demarrage || attente.length || !peer) return;
    conn?.close();
    peer.destroy();
    peer = conn = tentative = null;
    clearInterval(gardien);
    gardien = null;
    majEtat();
  }, 1500);
}

// ---------- Affichage ----------

function majEtat() {
  let texte, ton;
  if (erreurMicro) {
    [texte, ton] = [erreurMicro, 'erreur'];
  } else if (!enAppel) {
    if (attente.length && peer) {
      [texte, ton] = liaisonOuverte()
        ? ['Envoi des vocaux restants…', 'attente']
        : ["En attente de l'ordinateur pour envoyer les vocaux…", 'attente'];
    } else {
      [texte, ton] = debutAppel ? ['Appel terminé', 'neutre'] : ['Démarrage…', 'attente'];
    }
  } else if (!peer?.open) {
    [texte, ton] = Date.now() - idPrisLe < 10000
      ? ['Déjà ouvert sur un autre téléphone ? Nouvel essai…', 'erreur']
      : ['Connexion…', 'attente'];
  } else if (!liaisonOuverte()) {
    [texte, ton] = Date.now() - injoignableLe < 30000
      ? ['Ordinateur injoignable depuis ce réseau', 'erreur']
      : ["En attente de l'ordinateur…", 'attente'];
  } else if (!appelOk) {
    [texte, ton] = ['Connexion audio…', 'attente'];
  } else {
    [texte, ton] = ['En appel', 'ok'];
  }
  el.etatTexte.textContent = texte;
  el.etat.dataset.ton = ton;
}

function ligne(v, statut, ton) {
  let li = lignes.get(v.id);
  if (!li) {
    li = document.createElement('li');
    li.innerHTML = '<span class="num"></span><span class="info"></span><span class="statut"></span>';
    if (v.type === 'photo') {
      li.querySelector('.num').textContent = '📷' + v.numero;
      li.querySelector('.info').textContent = `Photo · ${heure(v.debut)}`;
    } else {
      li.querySelector('.num').textContent = '#' + v.numero;
      const coupe = v.perdu >= 0.1 ? ` · ${v.perdu.toFixed(1).replace('.', ',')} s coupées` : '';
      li.querySelector('.info').textContent = `${duree(v.duree)} · ${heure(v.debut)}${coupe}`;
      if (coupe) li.querySelector('.info').classList.add('coupe');
    }
    el.liste.prepend(li);
    lignes.set(v.id, li);
    el.journal.hidden = false;
  }
  li.dataset.ton = ton;
  li.querySelector('.statut').textContent = statut;
}

function flash(titre, classe) {
  el.bouton.classList.remove('envoye', 'refus');
  void el.bouton.offsetWidth;  // relance l'animation
  el.bouton.classList.add(classe);
  el.boutonTitre.textContent = titre;
  clearTimeout(flash.minuteur);
  flash.minuteur = setTimeout(() => {
    el.bouton.classList.remove(classe);
    el.boutonTitre.textContent = enAppel ? 'Envoyer' : 'Rappeler';
  }, 700);
}
