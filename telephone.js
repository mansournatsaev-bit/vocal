// Page téléphone : l'appel avec l'ordinateur démarre dès l'ouverture du lien, et le micro
// est enregistré en continu. Chaque appui sur le gros bouton envoie le morceau depuis l'appui précédent.

const $ = sel => document.querySelector(sel);
const el = {
  etat: $('#etat'), etatTexte: $('#etat-texte'), chrono: $('#chrono'), raccrocher: $('#raccrocher'),
  niveau: $('#niveau'), niveauOrdi: $('#niveau-ordi'), alerte: $('#alerte'),
  journal: $('#journal'), liste: $('#liste'), voile: $('#voile'), telecommande: $('#telecommande'),
  ecranNoir: $('#ecran-noir'), volume: $('#volume'), volumeValeur: $('#volume-valeur'),
  bouton: $('#gros-bouton'), boutonTitre: $('#bouton-titre'), boutonSous: $('#bouton-sous'),
  son: $('#son-distant'),
};

// Présent quand la page tourne dans l'appli Android : elle gère les boutons de volume et l'écran noir.
const natif = window.VocalNatif || null;

const base = new Base('vocal-telephone');
const attente = [];          // vocaux pas encore confirmés par l'ordinateur, du plus ancien au plus récent
const donnees = new Map();   // id → WAV (ArrayBuffer) des vocaux enregistrés pendant cette session
const accuses = new Map();   // id → fonction appelée quand l'ordinateur confirme la réception
const lignes = new Map();    // id → <li> du journal

let micro = null, ctx = null, lecteurMicro = null, tauxEch = 48000;
let enAppel = false, demarrage = false, microCoupe = false, erreurMicro = '';
let morceaux = [], frames = 0, crete = 0, creteOrdi = 0, dernierPCM = 0, debutSegment = 0, debutAppel = 0;
let perduSegment = 0;        // secondes de micro manquantes dans le segment en cours (remplacées par du silence)
let peer = null, conn = null, appel = null, tentative = null;
let appelOk = false, appelDepuis = 0, dernierSigne = 0, connDepuis = 0, idPrisLe = 0;
let envoiEnCours = false, gardien = null, horloge = null, veille = null;
let silence = null, sonsCtx = null, dernierAppuiDistant = 0;  // bouton des écouteurs

chargerAttente();
reglerVolume(Number(memo.lire('vocal-volume') ?? 100));
console.info(`Son de l'ordinateur : ${el.volume.value} %`);
demarrer();

el.bouton.addEventListener('click', () => (enAppel ? envoyer() : demarrer()));
el.raccrocher.addEventListener('click', () => raccrocher());
el.ecranNoir.addEventListener('click', () => natif?.ecranNoir());
el.volume.addEventListener('input', () => reglerVolume(Number(el.volume.value)));
el.volume.addEventListener('change', () => console.info(`Son de l'ordinateur : ${el.volume.value} %`));
// Appelée par l'appli Android quand on appuie sur un bouton de volume.
window.vocalEnvoyer = envoyerDepuisBouton;

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
  for (const { wav, ...v } of restants) {
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
    console.info('Démarrage : micro obtenu');
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
  rafraichir();
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

// Un vocal envoyé fait forcément moins de 5 minutes : arrivé à 5 minutes, tout ce qui a été dit
// depuis le dernier envoi est effacé et l'enregistrement repart de 0.
const DUREE_MAX = 5 * 60;  // s

function recevoirPCM(pcm) {
  if (!enAppel) return;
  morceaux.push(pcm);
  frames += pcm.length;
  dernierPCM = Date.now();
  for (let i = 0; i < pcm.length; i += 8) {
    const v = Math.abs(pcm[i]);
    if (v > crete) crete = v;
  }
  if (frames >= tauxEch * DUREE_MAX) effacerSegment();
}

function effacerSegment() {
  morceaux = [];
  frames = 0;
  perduSegment = 0;
  debutSegment = Date.now();
  console.info('Vocal de 5 minutes effacé : enregistrement reparti de 0');
  flash('Effacé (5 min)', 'refus');
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
  try { await base.mettre({ ...v, wav }); } catch (e) { console.warn('Sauvegarde locale impossible', e); }

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
}

function arreterMicro() {
  lecteurMicro?.cancel().catch(() => {});
  lecteurMicro = null;
  micro?.getTracks().forEach(t => t.stop());
  micro = null;
  ctx?.close().catch(() => {});
  ctx = null;
}

// Les boutons de volume envoient le vocal : le son de l'ordinateur se règle avec le curseur.
// Le niveau est gardé en mémoire (écran éteint, appli relancée).
function reglerVolume(pourcent) {
  const v = Math.max(0, Math.min(100, Number.isFinite(pourcent) ? pourcent : 100));
  el.son.volume = v / 100;
  el.volume.value = v;
  el.volumeValeur.textContent = `${v} %`;
  memo.ecrire('vocal-volume', v);
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

// ---------- Réseau : liaison de données + appel ----------

function demarrerReseau() {
  if (!peer || peer.destroyed) {
    peer = new Peer(ID_TELEPHONE, optionsPeer());
    peer.on('open', surveiller);
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
    if (enAppel || attente.length) demarrerReseau();
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
  const abandon = setTimeout(() => {
    if (!c.open) c.close();
    if (tentative === c) tentative = null;
  }, 8000);
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
  c.on('open', () => {
    if (liaisonOuverte() && Date.now() - connDepuis < 5000) return c.close();
    tentative?.close();
    tentative = null;
    brancher(c);
  });
  c.on('close', () => { if (conn === c) debrancher(); });
  c.on('error', e => console.warn('Liaison', e));
}

function brancher(c) {
  if (conn && conn !== c) conn.close();
  conn = c;
  dernierSigne = connDepuis = Date.now();
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
    el.son.srcObject = flux;
    el.son.play().catch(() => {});
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
  majEtat();
}

// ---------- Envoi des vocaux ----------

async function pomper() {
  if (envoiEnCours) return;
  envoiEnCours = true;
  try {
    while (attente.length && liaisonOuverte()) {
      const v = attente[0];
      const wav = donnees.get(v.id) || (await base.lire(v.id))?.wav;
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
  envoyerMsg(c, { t: 'debut', id: v.id, numero: v.numero, debut: v.debut, duree: v.duree, nom: v.nom, taille: wav.byteLength });
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
  if (enAppel || attente.length || !peer) return;
  setTimeout(() => {
    if (enAppel || attente.length || !peer) return;
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
    [texte, ton] = ["En attente de l'ordinateur…", 'attente'];
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
    li.querySelector('.num').textContent = '#' + v.numero;
    const coupe = v.perdu >= 0.1 ? ` · ${v.perdu.toFixed(1).replace('.', ',')} s coupées` : '';
    li.querySelector('.info').textContent = `${duree(v.duree)} · ${heure(v.debut)}${coupe}`;
    if (coupe) li.querySelector('.info').classList.add('coupe');
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
