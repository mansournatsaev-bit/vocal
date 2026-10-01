// Outils partagés par la page téléphone (index.html) et la page écoute (ecoute.html).

// null = serveurs par défaut de PeerJS (STUN Google + relais TURN de PeerJS).
// Pour ton propre relais (Cloudflare, Metered…), mets une liste ici, par exemple :
// [{ urls: 'stun:stun.l.google.com:19302' },
//  { urls: 'turn:exemple.com:3478', username: '…', credential: '…' }]
const ICE_SERVERS = null;

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const TAILLE_MORCEAU = 16 * 1024;  // taille des paquets envoyés sur le canal de données
const DELAI_SILENCE = 20000;       // ms sans nouvelles de l'autre côté avant de couper la liaison

// Un seul salon par site, déduit de son adresse : le lien suffit, sans code.
// Ex. mansournatsaev-bit.github.io/vocal/ → « mansournatsaev-bit-github-io-vocal ».
const SALON = (location.host + location.pathname.replace(/[^/]*$/, ''))
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const ID_TELEPHONE = 'vocalbtn-v1-' + SALON + '-tel';
const ID_ORDI = 'vocalbtn-v1-' + SALON + '-pc';
const LIEN_ORDI = new URL('./', location.href).href;

function optionsPeer() {
  return ICE_SERVERS ? { config: { iceServers: ICE_SERVERS } } : {};
}

function envoyerMsg(liaison, message) {
  if (liaison && liaison.open) liaison.send(JSON.stringify(message));
}

const memo = {
  lire(cle) { try { return localStorage.getItem(cle); } catch { return null; } },
  ecrire(cle, valeur) { try { localStorage.setItem(cle, valeur); } catch {} },
};

function nouvelId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const alea = crypto.getRandomValues(new Uint32Array(12));
  return Date.now().toString(36) + Array.from(alea, x => ALPHABET[x % ALPHABET.length]).join('');
}

function duree(secondes) {
  const t = Math.max(0, Math.floor(secondes));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function heure(ms) {
  return new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function nomFichier(numero, ms) {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `vocal-${String(numero).padStart(3, '0')}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}.wav`;
}

// L'appel en direct passe en Opus 128 kb/s au lieu des ~32 kb/s par défaut de WebRTC.
function opusHauteQualite(sdp) {
  const rtpmap = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!rtpmap) return sdp;
  const pt = rtpmap[1];
  const voulu = ['maxaveragebitrate=128000', 'useinbandfec=1'];
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, (_, params) => {
      const gardes = params.split(';').filter(p => p && !/^(maxaveragebitrate|useinbandfec)=/.test(p));
      return `a=fmtp:${pt} ${gardes.concat(voulu).join(';')}`;
    });
  }
  return sdp.replace(rtpmap[0], `${rtpmap[0]}\r\na=fmtp:${pt} ${voulu.join(';')}`);
}

// Petit stockage IndexedDB (clé : id). Retombe sur la mémoire si IndexedDB est indisponible.
class Base {
  constructor(nom) {
    this.memoire = null;
    this.pret = new Promise(ok => {
      let ouverture;
      try { ouverture = indexedDB.open(nom, 1); } catch { this.memoire = new Map(); return ok(); }
      ouverture.onupgradeneeded = () => ouverture.result.createObjectStore('elements', { keyPath: 'id' });
      ouverture.onsuccess = () => { this.db = ouverture.result; ok(); };
      ouverture.onerror = () => { this.memoire = new Map(); ok(); };
    });
  }

  _tx(mode, action) {
    return new Promise((ok, ko) => {
      const tx = this.db.transaction('elements', mode);
      const requete = action(tx.objectStore('elements'));
      tx.oncomplete = () => ok(requete.result);
      tx.onerror = tx.onabort = () => ko(tx.error);
    });
  }

  async mettre(element) {
    await this.pret;
    if (this.memoire) return void this.memoire.set(element.id, element);
    return this._tx('readwrite', s => s.put(element));
  }

  async lire(id) {
    await this.pret;
    if (this.memoire) return this.memoire.get(id);
    return this._tx('readonly', s => s.get(id));
  }

  async tout() {
    await this.pret;
    if (this.memoire) return [...this.memoire.values()];
    return this._tx('readonly', s => s.getAll());
  }

  async suppr(id) {
    await this.pret;
    if (this.memoire) return void this.memoire.delete(id);
    return this._tx('readwrite', s => s.delete(id));
  }
}
