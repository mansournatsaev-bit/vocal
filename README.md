# Vocal

Appel en direct téléphone ↔ ordinateur. Le téléphone enregistre en continu en qualité maximale ;
chaque appui sur le gros bouton envoie à l'ordinateur un fichier WAV avec tout ce qui a été dit
depuis l'appui précédent. Les vocaux s'accumulent sur la page de l'ordinateur.

- `index.html` : page du téléphone (le bouton d'envoi occupe le tiers bas de l'écran)
- `ecoute.html` : page de l'ordinateur (appel + liste des vocaux reçus)

Pas de serveur à installer : l'appel et les fichiers passent directement d'un appareil à l'autre
(WebRTC, via le service gratuit PeerJS pour la mise en relation).

## Mettre en ligne avec GitHub Pages

1. Sur GitHub : **New repository**, nom `vocal`, **Public**, puis **Create repository**.
2. Clique sur **uploading an existing file** et glisse tous les fichiers de ce dossier, puis **Commit changes**.
3. **Settings → Pages** : Source **Deploy from a branch**, branche **main**, dossier **/ (root)**, puis **Save**.
4. Après une minute environ, ouvre `https://TON-PSEUDO.github.io/vocal/` dans Chrome sur le téléphone.

## Utilisation

1. Sur le téléphone, appuie sur **Envoyer le lien d'écoute** et envoie le lien à la personne sur ordinateur.
2. Elle ouvre le lien et clique sur **Rejoindre l'appel**.
3. Sur le téléphone, appuie sur **Démarrer l'appel**, puis sur **Envoyer** à chaque fois que tu veux envoyer un vocal.

À savoir :

- Garde l'appli au premier plan, l'écran reste allumé tout seul. Si l'écran se verrouille, l'enregistrement se met en pause.
- Avec **Son brut**, mets des écouteurs, sinon l'autre personne s'entend en écho.
- Un vocal non reçu reste sur le téléphone et repart dès que l'ordinateur est de nouveau là, même après un rechargement de la page.
- Les vocaux reçus sont gardés dans le navigateur de l'ordinateur. Télécharge ceux que tu veux conserver.
- Le WAV fait environ 5,8 Mo par minute.
