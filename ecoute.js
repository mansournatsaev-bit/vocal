// Page ordinateur : répond à l'appel du téléphone et accumule les vocaux reçus.

const $ = sel => document.querySelector(sel);
const el = {
  accueil: $('#accueil'), form: $('#form-code'), champ: $('#champ-code'),
  salon: $('#salon'), salonInfo: $('#salon-info'), controles: $('#controles'),
  etat: $('#etat'), etatTexte: $('#etat-texte'), chrono: $('#chrono'),
  boutonMicro: $('#bouton-micro'), activerSon: $('#activer-son'),
  reception: $('#reception'), receptionTexte: $('#reception-texte'), receptionBarre: $('#reception-barre'),
  resume: $('#resume'), toutEffacer: $('#tout-effacer'), vocaux: $('#vocaux'), vide: $('#vide'),
  son: $('#son-distant'),
};

const base = new Base('vocal-ecoute');
const affiches = new Map();  // id → { vocal, li, url }

const liaisons = new Map();  // liaison ouverte avec le téléphone → dernier signe de vie (ms)

let code = '';
let peer = null, appel = null, micro = null, tentative = null;
let debutAppel = 0, termine = false, idPrisLe = 0;
let reception = null, nonLus = 0, dessinPrevu = false;

el.champ.value = nettoyerCode(location.hash.slice(1)) || memo.lire('vocal-code-ecoute') || '';
if (!el.champ.value) el.champ.focus();

el.form.addEventListener('submit', e => {
  e.preventDefault();
  const c = nettoyerCode(el.champ.value);
  if (!c) return el.champ.focus();
  rejoindre(c);
});
el.boutonMicro.addEventListener('click', basculerMicro);
el.activerSon.addEventListener('click', jouer);
el.toutEffacer.addEventListener('click', toutEffacer);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { nonLus = 0; majTitre(); }
});

async function rejoindre(c) {
  if (!window.Peer) return alert("PeerJS n'a pas pu se charger. Vérifie la connexion internet puis recharge la page.");
  code = c;
  memo.ecrire('vocal-code-ecoute', code);
  history.replaceState(null, '', '#' + code);
  el.accueil.hidden = true;
  el.salon.hidden = false;
  el.controles.hidden = false;
  el.salonInfo.textContent = 'Salon ' + code;

  try {
    micro = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    micro = null;  // on peut écouter sans micro
  }
  majMicro();
  await chargerVocaux();

  peer = new Peer(idOrdi(code), optionsPeer());
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
  setInterval(surveiller, 3000);
  setInterval(majChrono, 1000);
  majEtat();
}

// ---------- Réseau ----------

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
  const c = tentative = peer.connect(idTelephone(code), { serialization: 'raw', reliable: true });
  const fin = () => { clearTimeout(abandon); if (tentative === c) tentative = null; };
  const abandon = setTimeout(() => { if (!c.open) c.close(); fin(); }, 8000);
  c.on('open', fin);
  accueillir(c);
}

function repondre(a) {
  if (appel && appel !== a) appel.close();
  appel = a;
  a.answer(micro || undefined, { sdpTransform: opusHauteQualite });
  a.on('stream', flux => {
    if (appel !== a) return;
    el.son.srcObject = flux;
    debutAppel = Date.now();
    jouer();
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
}

function surveiller() {
  if (!peer || peer.destroyed) return;
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
      id, code, numero: Number(m.numero) || 0, debut: Number(m.debut) || Date.now(),
      duree: Number(m.duree) || 0, nom: String(m.nom || `vocal-${id}.wav`), recuLe: Date.now(),
      blob: new Blob(r.morceaux, { type: 'audio/wav' }),
    };
    try {
      await base.mettre(vocal);
    } catch (e) {
      console.warn('Sauvegarde impossible', e);
      vocal.nonSauve = true;
    }
    afficherVocal(vocal, true);
    if (document.hidden) { nonLus++; majTitre(); }
  }
  envoyerMsg(c, { t: 'recu', id });
}

// ---------- Micro de l'ordinateur ----------

function basculerMicro() {
  const piste = micro?.getAudioTracks()[0];
  if (!piste) return;
  piste.enabled = !piste.enabled;
  majMicro();
}

function majMicro() {
  const piste = micro?.getAudioTracks()[0];
  el.boutonMicro.disabled = !piste;
  el.boutonMicro.textContent = !piste ? 'Pas de micro' : piste.enabled ? 'Couper mon micro' : 'Réactiver mon micro';
  el.boutonMicro.dataset.coupe = piste && !piste.enabled ? 'oui' : 'non';
}

function jouer() {
  el.son.play()
    .then(() => { el.activerSon.hidden = true; })
    .catch(() => { el.activerSon.hidden = false; });
}

// ---------- Vocaux ----------

async function chargerVocaux() {
  const tous = (await base.tout()).filter(v => v.code === code);
  for (const v of tous) afficherVocal(v, false);
}

function afficherVocal(v, nouveau) {
  const url = URL.createObjectURL(v.blob);
  const li = document.createElement('li');
  li.className = 'vocal' + (nouveau ? ' nouveau' : '');
  li.innerHTML = `
    <div class="vocal-tete">
      <span class="vocal-num"></span>
      <span class="vocal-meta"></span>
      <a class="bouton-secondaire petit-bouton">Télécharger</a>
    </div>
    <audio controls preload="metadata"></audio>
    <p class="vocal-alerte" hidden>Pas sauvegardé dans le navigateur : télécharge-le pour le garder.</p>`;
  li.querySelector('.vocal-num').textContent = 'Vocal ' + v.numero;
  li.querySelector('.vocal-meta').textContent = `${duree(v.duree)} · ${dateHeure(v.debut)}`;
  const lien = li.querySelector('a');
  lien.href = url;
  lien.download = v.nom;
  li.querySelector('audio').src = url;
  li.querySelector('.vocal-alerte').hidden = !v.nonSauve;

  // Le plus récent en haut.
  const suivant = [...affiches.values()]
    .filter(a => a.vocal.debut < v.debut)
    .sort((a, b) => b.vocal.debut - a.vocal.debut)[0];
  el.vocaux.insertBefore(li, suivant ? suivant.li : null);
  affiches.set(v.id, { vocal: v, li, url });
  majResume();
}

async function toutEffacer() {
  if (!affiches.size || !confirm(`Effacer les ${affiches.size} vocaux de ce navigateur ?`)) return;
  for (const [id, a] of affiches) {
    URL.revokeObjectURL(a.url);
    a.li.remove();
    await base.suppr(id).catch(() => {});
  }
  affiches.clear();
  majResume();
}

function majResume() {
  const n = affiches.size;
  const total = [...affiches.values()].reduce((s, a) => s + a.vocal.duree, 0);
  el.resume.textContent = n ? `${n} ${n > 1 ? 'vocaux' : 'vocal'} · ${duree(total)} au total` : 'Aucun vocal pour l\'instant';
  el.vide.hidden = n > 0;
  el.toutEffacer.hidden = n === 0;
}

function afficherReception() {
  if (dessinPrevu) return;
  dessinPrevu = true;
  requestAnimationFrame(() => {
    dessinPrevu = false;
    if (!reception) return void (el.reception.hidden = true);
    const { meta, recu } = reception;
    const p = meta.taille ? recu / meta.taille : 0;
    el.reception.hidden = false;
    el.receptionTexte.textContent = `Réception du vocal ${meta.numero} (${duree(meta.duree)})… ${Math.round(p * 100)} %`;
    el.receptionBarre.style.transform = `scaleX(${p})`;
  });
}

// ---------- État ----------

function majEtat() {
  let texte, ton;
  if (!peer?.open) {
    [texte, ton] = Date.now() - idPrisLe < 10000
      ? ['Ce salon est déjà ouvert dans un autre onglet ? Nouvel essai…', 'erreur']
      : ['Connexion au serveur…', 'attente'];
  } else if (appel && debutAppel) {
    [texte, ton] = ['En appel', 'ok'];
  } else if (liaisons.size) {
    [texte, ton] = termine ? ['Appel terminé', 'neutre'] : ['Téléphone connecté, audio en cours…', 'attente'];
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
