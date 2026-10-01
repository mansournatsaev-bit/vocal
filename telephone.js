// Page téléphone : appel en direct avec l'ordinateur + enregistrement continu.
// Chaque appui sur le gros bouton coupe l'enregistrement et envoie le morceau depuis l'appui précédent.

const $ = sel => document.querySelector(sel);
const el = {
  etat: $('#etat'), etatTexte: $('#etat-texte'), chrono: $('#chrono'), raccrocher: $('#raccrocher'),
  accueil: $('#accueil'), lien: $('#lien'), partager: $('#partager'),
  brut: $('#son-brut'), erreur: $('#erreur'),
  direct: $('#direct'), niveau: $('#niveau'), alerte: $('#alerte'),
  journal: $('#journal'), liste: $('#liste'),
  bouton: $('#gros-bouton'), boutonTitre: $('#bouton-titre'), boutonSous: $('#bouton-sous'),
  son: $('#son-distant'),
};

const base = new Base('vocal-telephone');
const attente = [];          // vocaux pas encore confirmés par l'ordinateur, du plus ancien au plus récent
const donnees = new Map();   // id → WAV (ArrayBuffer) des vocaux enregistrés pendant cette session
const accuses = new Map();   // id → fonction appelée quand l'ordinateur confirme la réception
const lignes = new Map();    // id → <li> du journal

let micro = null, ctx = null, enAppel = false, microCoupe = false;
let morceaux = [], frames = 0, crete = 0, debutSegment = 0, debutAppel = 0;
let peer = null, conn = null, appel = null, tentative = null;
let appelOk = false, appelDepuis = 0, dernierSigne = 0, idPrisLe = 0;
let envoiEnCours = false, gardien = null, horloge = null, veille = null;

el.brut.checked = memo.lire('vocal-brut') !== '0';
el.lien.textContent = LIEN_ORDI.replace(/^https?:\/\//, '');
chargerAttente();

el.bouton.addEventListener('click', () => (enAppel ? envoyer() : demarrer()));
el.raccrocher.addEventListener('click', raccrocher);
el.partager.addEventListener('click', partagerLien);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !enAppel) return;
  garderEcranAllume();
  ctx?.resume();
});

addEventListener('beforeunload', e => {
  if (enAppel || attente.length) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- Lien de l'ordinateur ----------

async function partagerLien() {
  if (navigator.share) {
    try { return await navigator.share({ title: 'Écoute mon appel', url: LIEN_ORDI }); }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(LIEN_ORDI);
    el.partager.textContent = 'Lien copié ✓';
    setTimeout(() => { el.partager.textContent = "Envoyer le lien à l'ordinateur"; }, 1500);
  } catch {
    prompt('Copie ce lien :', LIEN_ORDI);
  }
}

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
  el.erreur.hidden = true;
  if (!window.Peer) return signaler("PeerJS n'a pas pu se charger. Vérifie la connexion internet puis recharge la page.");
  if (!navigator.mediaDevices || !window.AudioWorkletNode) return signaler('Ouvre cette page en https (ou sur localhost) dans Chrome.');

  el.bouton.disabled = true;
  const brut = el.brut.checked;
  memo.ecrire('vocal-brut', brut ? '1' : '0');
  try {
    micro = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: !brut, noiseSuppression: !brut, autoGainControl: !brut, channelCount: 1 },
    });
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule('capture-worklet.js');
    const capteur = new AudioWorkletNode(ctx, 'capture');
    capteur.port.onmessage = e => recevoirPCM(e.data);
    ctx.createMediaStreamSource(micro).connect(capteur).connect(ctx.destination);
    await ctx.resume();
  } catch (e) {
    arreterMicro();
    el.bouton.disabled = false;
    return signaler(e.name === 'NotAllowedError'
      ? 'Accès au micro refusé. Autorise-le dans les réglages du site (icône à gauche de l\'adresse).'
      : 'Impossible de démarrer le micro : ' + e.message);
  }

  micro.getAudioTracks()[0].addEventListener('ended', () => { microCoupe = true; });
  enAppel = true;
  microCoupe = false;
  morceaux = [];
  frames = 0;
  debutSegment = debutAppel = Date.now();

  el.accueil.hidden = true;
  el.direct.hidden = false;
  el.raccrocher.hidden = false;
  el.bouton.disabled = false;
  el.boutonTitre.textContent = 'Envoyer';
  garderEcranAllume();
  horloge = setInterval(rafraichir, 100);
  demarrerReseau();
  rafraichir();
}

function recevoirPCM(pcm) {
  if (!enAppel) return;
  morceaux.push(pcm);
  frames += pcm.length;
  for (let i = 0; i < pcm.length; i += 8) {
    const v = Math.abs(pcm[i]);
    if (v > crete) crete = v;
  }
}

function rafraichir() {
  if (!enAppel) return;
  el.boutonSous.textContent = `${duree(frames / ctx.sampleRate)} à envoyer`;
  el.chrono.textContent = duree((Date.now() - debutAppel) / 1000);
  const db = crete > 0 ? 20 * Math.log10(crete / 32768) : -100;
  el.niveau.style.transform = `scaleX(${Math.max(0, Math.min(1, (db + 60) / 60))})`;
  crete = 0;
  const enPause = microCoupe || ctx.state !== 'running';
  el.alerte.hidden = !enPause;
  if (enPause) {
    el.alerte.textContent = microCoupe
      ? 'Le micro a été coupé par le téléphone. Raccroche puis redémarre l\'appel.'
      : 'Micro en pause : garde l\'écran allumé et l\'appli au premier plan.';
  }
}

async function envoyer() {
  const sr = ctx.sampleRate;
  if (frames < sr * 0.5) return flash('Trop court', 'refus');

  const pcm = morceaux, n = frames, debut = debutSegment;
  morceaux = [];
  frames = 0;
  debutSegment = Date.now();
  flash('Envoyé ✓', 'envoye');
  navigator.vibrate?.(40);

  const numero = Number(memo.lire('vocal-num') || 0) + 1;
  memo.ecrire('vocal-num', numero);
  const v = { id: nouvelId(), numero, debut, duree: n / sr, nom: nomFichier(numero, debut) };
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

async function raccrocher() {
  if (!enAppel) return;
  const reste = frames / ctx.sampleRate;
  if (reste >= 0.5 && confirm(`Envoyer les ${duree(reste)} pas encore envoyées ?`)) await envoyer();

  enAppel = false;
  envoyerMsg(conn, { t: 'raccroche' });
  couperAppel();
  arreterMicro();
  clearInterval(horloge);
  veille?.release().catch(() => {});
  veille = null;

  el.accueil.hidden = false;
  el.direct.hidden = true;
  el.raccrocher.hidden = true;
  el.chrono.textContent = '';
  el.boutonTitre.textContent = "Démarrer l'appel";
  el.boutonSous.textContent = "Le micro s'active, l'enregistrement commence";
  verifierFin();
}

function arreterMicro() {
  micro?.getTracks().forEach(t => t.stop());
  micro = null;
  ctx?.close().catch(() => {});
  ctx = null;
}

async function garderEcranAllume() {
  try { veille = await navigator.wakeLock?.request('screen'); } catch {}
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
  gardien ??= setInterval(surveiller, 3000);
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
  if (!peer || peer.destroyed) return;
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
// la liaison gardée, pour qu'il n'en reste qu'une même si les deux côtés appellent en même temps.
function accepter(c) {
  c.on('open', () => {
    if (liaisonOuverte()) return c.close();
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
  dernierSigne = Date.now();
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
    if (appel !== a) return;
    appelOk = true;
    el.son.srcObject = flux;
    el.son.play().catch(() => {});
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
  if (!enAppel) {
    if (attente.length && peer) {
      [texte, ton] = liaisonOuverte()
        ? ['Envoi des vocaux restants…', 'attente']
        : ["En attente de l'ordinateur pour envoyer les vocaux…", 'attente'];
    } else {
      [texte, ton] = ['Prêt', 'neutre'];
    }
  } else if (!peer?.open) {
    [texte, ton] = Date.now() - idPrisLe < 10000
      ? ['Code déjà ouvert sur un autre appareil ? Nouvel essai…', 'erreur']
      : ['Connexion au serveur…', 'attente'];
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
    li.querySelector('.info').textContent = `${duree(v.duree)} · ${heure(v.debut)}`;
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
    el.boutonTitre.textContent = enAppel ? 'Envoyer' : "Démarrer l'appel";
  }, 700);
}

function signaler(message) {
  el.erreur.textContent = message;
  el.erreur.hidden = false;
}
