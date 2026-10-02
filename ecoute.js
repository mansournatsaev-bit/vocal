// Page ordinateur : s'ouvre avec le lien du téléphone et entend l'appel tout de suite.
// Les vocaux reçus s'empilent dans l'ordre : clic = télécharger, glisser = déposer où on veut.

const $ = sel => document.querySelector(sel);
const el = {
  etat: $('#etat'), etatTexte: $('#etat-texte'), chrono: $('#chrono'), noteMicro: $('#note-micro'),
  niveauMicro: $('#niveau-micro'), niveauTel: $('#niveau-tel'),
  zone: $('#zone-recu'), zoneTitre: $('#recu-titre'), zoneSous: $('#recu-sous'), zoneIndice: $('#recu-indice'),
  zoneProgression: $('#recu-progression'), zoneBarre: $('#recu-barre'),
  resume: $('#resume'), toutEffacer: $('#tout-effacer'), vocaux: $('#vocaux'),
  activerSon: $('#activer-son'), son: $('#son-distant'),
};

const base = new Base('vocal-ecoute');
const affiches = new Map();  // id → { vocal, li, url }
const liaisons = new Map();  // liaison ouverte avec le téléphone → dernier signe de vie (ms)
const lecteur = new Audio();

let peer = null, appel = null, micro = null, microPret = null, tentative = null;
let debutAppel = 0, termine = false, idPrisLe = 0;
let reception = null, dernier = null, enLecture = null, nonLus = 0, dessinPrevu = false;
let creteMicro = 0, creteTel = 0;

el.toutEffacer.addEventListener('click', toutEffacer);
rendreGlissable(el.zone, () => dernier);
lecteur.addEventListener('ended', () => majLecture(null));
// Si le navigateur a bloqué le son de l'appel, le premier clic n'importe où le débloque.
document.addEventListener('pointerdown', () => { if (el.son.srcObject && el.son.paused) jouer(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { nonLus = 0; majTitre(); }
});

majZone();
demarrer();

async function demarrer() {
  await chargerVocaux();
  if (!window.Peer) {
    el.etatTexte.textContent = 'Connexion impossible, recharge la page';
    el.etat.dataset.ton = 'erreur';
    return;
  }

  // Le micro est demandé tout de suite. L'appel n'attend pas la réponse : tant que le micro
  // n'est pas autorisé, le téléphone entend du silence (voir repondre).
  microPret = navigator.mediaDevices.getUserMedia({ audio: true })
    .then(flux => {
      micro = flux;
      el.noteMicro.hidden = true;
      suivreNiveau(flux.getAudioTracks()[0], c => { if (c > creteMicro) creteMicro = c; });
    })
    .catch(() => {
      micro = null;
      el.noteMicro.textContent = 'Micro refusé : le téléphone ne t\'entend pas. Autorise-le avec l\'icône à gauche de l\'adresse, puis recharge la page.';
    });

  creerPeer();
  setInterval(surveiller, 3000);
  setInterval(majChrono, 1000);
  setInterval(majNiveaux, 100);
  majEtat();
}

function majNiveaux() {
  el.niveauMicro.style.transform = `scaleX(${largeurNiveau(creteMicro)})`;
  el.niveauTel.style.transform = `scaleX(${largeurNiveau(creteTel)})`;
  creteMicro = creteTel = 0;
}

// ---------- Réseau ----------

function creerPeer() {
  tentative = null;
  peer = new Peer(ID_ORDI, optionsPeer());
  peer.on('open', surveiller);
  peer.on('disconnected', majEtat);
  peer.on('error', err => {
    if (err.type === 'peer-unavailable') {
      // Le téléphone n'a pas encore démarré l'appel : on réessaie au prochain tour.
      tentative?.close();
      tentative = null;
    } else if (err.type === 'unavailable-id') {
      idPrisLe = Date.now();
    } else {
      console.warn('PeerJS', err.type, err);
    }
    majEtat();
  });
  peer.on('connection', accueillir);
  peer.on('call', repondre);
}

// Le téléphone choisit la liaison qu'il garde : ici on écoute toutes celles qui sont ouvertes.
function accueillir(c) {
  c.on('open', () => {
    liaisons.set(c, Date.now());
    termine = false;
    majEtat();
  });
  c.on('data', d => recevoir(c, d));
  c.on('close', () => oublier(c));
  c.on('error', e => console.warn('Liaison', e));
}

function oublier(c) {
  liaisons.delete(c);
  if (reception?.liaison === c) {
    reception = null;
    afficherReception();
  }
  majEtat();
}

// En arrivant (puis toutes les 3 s tant qu'on n'est pas relié), on essaie aussi de joindre le téléphone.
function appelerTelephone() {
  if (tentative || liaisons.size || !peer?.open) return;
  const c = tentative = peer.connect(ID_TELEPHONE, { serialization: 'raw', reliable: true });
  const fin = () => { clearTimeout(abandon); if (tentative === c) tentative = null; };
  const abandon = setTimeout(() => { if (!c.open) c.close(); fin(); }, 8000);
  c.on('open', fin);
  accueillir(c);
}

async function repondre(a) {
  if (appel && appel !== a) appel.close();
  appel = a;
  a.on('stream', flux => {
    if (appel !== a || el.son.srcObject === flux) return;
    el.son.srcObject = flux;
    debutAppel = Date.now();
    jouer();
    suivreNiveau(flux.getAudioTracks()[0], c => { if (appel === a && c > creteTel) creteTel = c; });
    majEtat();
  });
  const fin = () => {
    if (appel !== a) return;
    appel = null;
    debutAppel = 0;
    el.son.srcObject = null;
    el.activerSon.hidden = true;
    majEtat();
  };
  a.on('close', fin);
  a.on('error', fin);
  // On décroche tout de suite pour entendre le téléphone. Si le micro n'est pas encore autorisé,
  // on envoie une piste muette, remplacée par le micro dès que la personne l'autorise.
  a.answer(micro || pisteMuette(), { sdpTransform: opusHauteQualite });
  if (micro) return;
  await microPret;
  const piste = micro?.getAudioTracks()[0];
  const envoi = piste && appel === a && a.peerConnection?.getSenders().find(s => s.track?.kind === 'audio');
  if (envoi) envoi.replaceTrack(piste);
}

let muette = null;
function pisteMuette() {
  if (!muette) muette = new AudioContext().createMediaStreamDestination().stream;
  return muette;
}

function surveiller() {
  // PeerJS détruit la connexion si la place est encore prise à l'ouverture (ancien onglet,
  // rechargement rapide) : on en recrée une jusqu'à ce que la place se libère.
  if (!peer || peer.destroyed) return creerPeer();
  if (peer.disconnected) {
    try { peer.reconnect(); } catch {}
  } else if (peer.open) {
    for (const [c, signe] of liaisons) {
      if (!c.open || Date.now() - signe > DELAI_SILENCE) {
        c.close();
        oublier(c);
      } else {
        envoyerMsg(c, { t: 'ping' });
      }
    }
    appelerTelephone();
  }
  majEtat();
}

function recevoir(c, d) {
  if (liaisons.has(c)) liaisons.set(c, Date.now());
  if (typeof d === 'string') {
    let m;
    try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'debut') { reception = { liaison: c, meta: m, morceaux: [], recu: 0 }; afficherReception(); }
    else if (m.t === 'fin') finaliser(c, m.id);
    else if (m.t === 'raccroche') { termine = true; majEtat(); }
    return;
  }
  if (reception?.liaison !== c) return;
  reception.morceaux.push(d);
  reception.recu += d.byteLength;
  afficherReception();
}

async function finaliser(c, id) {
  const r = reception;
  if (r?.liaison !== c) return;
  reception = null;
  afficherReception();
  // Vocal incomplet : on ne confirme pas, le téléphone le renverra.
  if (r.meta.id !== id || r.recu !== r.meta.taille) return;

  if (!affiches.has(id) && !(await base.lire(id))) {
    const m = r.meta;
    const vocal = {
      id, numero: Number(m.numero) || 0, debut: Number(m.debut) || Date.now(),
      duree: Number(m.duree) || 0, nom: String(m.nom || `vocal-${id}.wav`), recuLe: Date.now(),
      blob: new Blob(r.morceaux, { type: 'audio/wav' }),
    };
    try {
      await base.mettre(vocal);
    } catch (e) {
      console.warn('Sauvegarde impossible', e);
    }
    afficherVocal(vocal, true);
    if (document.hidden) { nonLus++; majTitre(); }
  }
  envoyerMsg(c, { t: 'recu', id });
}

function jouer() {
  el.son.play()
    .then(() => { el.activerSon.hidden = true; })
    .catch(() => { el.activerSon.hidden = false; });
}

// ---------- Vocaux ----------

async function chargerVocaux() {
  for (const v of await base.tout()) afficherVocal(v, false);
}

const ICONE_ONDE = '<svg class="fichier-icone" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></svg>';
const ICONE_LECTURE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICONE_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

function afficherVocal(v, nouveau) {
  const url = URL.createObjectURL(v.blob);
  const li = document.createElement('li');
  li.className = 'fichier' + (nouveau ? ' nouveau' : '');
  li.innerHTML = `
    <a class="fichier-lien" draggable="true" title="Clique pour télécharger, ou glisse le fichier où tu veux">
      ${ICONE_ONDE}
      <span class="fichier-texte"><span class="fichier-nom"></span><span class="fichier-meta"></span></span>
      <span class="fichier-action">Télécharger</span>
    </a>
    <button class="ecouter" aria-label="Écouter">${ICONE_LECTURE}</button>`;
  li.querySelector('.fichier-nom').textContent = 'Vocal ' + v.numero;
  li.querySelector('.fichier-meta').textContent = `${duree(v.duree)} · ${dateHeure(v.debut)}`;
  const lien = li.querySelector('a');
  lien.href = url;
  lien.download = v.nom;
  rendreGlissable(lien, () => v);
  li.querySelector('.ecouter').addEventListener('click', () => ecouter(v.id));

  // Dans l'ordre d'enregistrement : le plus récent en bas.
  const suivant = [...affiches.values()]
    .filter(a => a.vocal.debut > v.debut)
    .sort((a, b) => a.vocal.debut - b.vocal.debut)[0];
  el.vocaux.insertBefore(li, suivant ? suivant.li : null);
  affiches.set(v.id, { vocal: v, li, url });

  if (!dernier || v.debut >= dernier.debut) dernier = v;
  if (nouveau) {
    li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.zone.classList.remove('flash');
    void el.zone.offsetWidth;  // relance l'animation
    el.zone.classList.add('flash');
  }
  majResume();
  majZone();
}

// Glisser un vocal le dépose comme un vrai fichier : sur le bureau, dans un dossier ou dans une page web.
function rendreGlissable(lien, obtenirVocal) {
  lien.addEventListener('dragstart', e => {
    const v = obtenirVocal();
    const a = v && affiches.get(v.id);
    if (!a) return e.preventDefault();
    try { e.dataTransfer.items.add(new File([v.blob], v.nom, { type: 'audio/wav' })); } catch {}
    e.dataTransfer.setData('DownloadURL', `audio/wav:${v.nom}:${a.url}`);
    e.dataTransfer.effectAllowed = 'copy';
  });
}

function ecouter(id) {
  if (enLecture === id) {
    lecteur.pause();
    return majLecture(null);
  }
  lecteur.src = affiches.get(id).url;
  lecteur.play().then(() => majLecture(id)).catch(() => majLecture(null));
}

function majLecture(id) {
  enLecture = id;
  for (const [cle, a] of affiches) {
    const actif = cle === id;
    a.li.classList.toggle('en-lecture', actif);
    const bouton = a.li.querySelector('.ecouter');
    bouton.innerHTML = actif ? ICONE_PAUSE : ICONE_LECTURE;
    bouton.setAttribute('aria-label', actif ? 'Pause' : 'Écouter');
  }
}

async function toutEffacer() {
  if (!affiches.size || !confirm(`Effacer les ${affiches.size} vocaux ?`)) return;
  lecteur.pause();
  majLecture(null);
  for (const [id, a] of affiches) {
    URL.revokeObjectURL(a.url);
    a.li.remove();
    await base.suppr(id).catch(() => {});
  }
  affiches.clear();
  dernier = null;
  majResume();
  majZone();
}

function majResume() {
  const n = affiches.size;
  const total = [...affiches.values()].reduce((s, a) => s + a.vocal.duree, 0);
  el.resume.textContent = n ? `${n} ${n > 1 ? 'vocaux' : 'vocal'} · ${duree(total)}` : 'Vocaux reçus';
  el.toutEffacer.hidden = n === 0;
}

// ---------- Zone « Tu as reçu » (le tiers haut de l'écran) ----------

function majZone() {
  const z = el.zone;
  el.zoneProgression.hidden = true;
  let titre, sous = '', indice = '';

  if (reception) {
    const { meta, recu } = reception;
    const p = meta.taille ? recu / meta.taille : 0;
    z.dataset.etat = 'reception';
    titre = `Réception du vocal ${meta.numero}…`;
    sous = `${duree(meta.duree)} · ${Math.round(p * 100)} %`;
    el.zoneProgression.hidden = false;
    el.zoneBarre.style.transform = `scaleX(${p})`;
  } else if (dernier) {
    z.dataset.etat = 'recu';
    titre = 'Tu as reçu un vocal';
    sous = `Vocal ${dernier.numero} · ${duree(dernier.duree)} · ${heure(dernier.debut)}`;
    indice = 'Clique pour le télécharger, ou glisse-le où tu veux';
  } else {
    z.dataset.etat = 'vide';
    titre = 'Aucun vocal pour l\'instant';
    sous = 'Les vocaux envoyés depuis le téléphone arriveront ici';
  }

  const a = z.dataset.etat === 'recu' && affiches.get(dernier.id);
  if (a) {
    z.href = a.url;
    z.download = dernier.nom;
    z.draggable = true;
  } else {
    z.removeAttribute('href');
    z.removeAttribute('download');
    z.draggable = false;
  }
  el.zoneTitre.textContent = titre;
  el.zoneSous.textContent = sous;
  el.zoneIndice.textContent = indice;
}

function afficherReception() {
  if (dessinPrevu) return;
  dessinPrevu = true;
  requestAnimationFrame(() => {
    dessinPrevu = false;
    majZone();
  });
}

// ---------- État ----------

function majEtat() {
  let texte, ton;
  if (!peer?.open) {
    [texte, ton] = Date.now() - idPrisLe < 10000
      ? ['Déjà ouvert sur un autre ordi ou onglet : ferme-le là-bas', 'erreur']
      : ['Connexion…', 'attente'];
  } else if (appel && debutAppel) {
    [texte, ton] = ['En appel', 'ok'];
  } else if (liaisons.size) {
    [texte, ton] = termine ? ['Appel terminé', 'neutre'] : ['Téléphone connecté', 'attente'];
  } else {
    [texte, ton] = termine ? ['Appel terminé', 'neutre'] : ['En attente du téléphone…', 'attente'];
  }
  el.etatTexte.textContent = texte;
  el.etat.dataset.ton = ton;
  majChrono();
}

function majChrono() {
  el.chrono.textContent = appel && debutAppel ? duree((Date.now() - debutAppel) / 1000) : '';
}

function majTitre() {
  document.title = (nonLus ? `(${nonLus}) ` : '') + 'Vocaux reçus';
}

function dateHeure(ms) {
  const d = new Date(ms);
  const memeJour = d.toDateString() === new Date().toDateString();
  return memeJour ? heure(ms) : d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
