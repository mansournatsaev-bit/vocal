# Vocal

Appel en direct téléphone ↔ ordinateur. Le téléphone enregistre en continu en qualité maximale ;
chaque appui sur le gros bouton envoie à l'ordinateur un fichier WAV avec tout ce qui a été dit
depuis l'appui précédent.

- **Ordinateur** : https://mansournatsaev-bit.github.io/vocal/ — on ouvre le lien et c'est tout :
  on entend l'appel, on parle, et les vocaux arrivent dans l'ordre. Clic sur un vocal = télécharger,
  glisser = le déposer où on veut (bureau, dossier, page web). Le tiers haut de l'écran annonce
  « Tu as reçu un vocal » et donne le dernier. **Tout effacer** vide la liste.
- **Téléphone** : le même lien ouvert sur un téléphone mène à l'appli (`tel.html`). Le bouton
  **Envoyer** occupe le tiers bas de l'écran.

Pas de code ni de serveur à installer : l'appel et les fichiers passent directement d'un appareil à
l'autre (WebRTC, via le service gratuit PeerJS pour la mise en relation). Il y a un seul salon par
site, donc toute personne qui ouvre le lien sur ordinateur rejoint l'appel.

## À savoir

- Garde l'appli au premier plan sur le téléphone, l'écran reste allumé tout seul.
- Avec **Son brut**, mets des écouteurs, sinon l'ordinateur s'entend en écho.
- Un vocal non reçu reste sur le téléphone et repart dès que l'ordinateur est de nouveau là.
- Les vocaux reçus sont gardés dans le navigateur de l'ordinateur jusqu'à **Tout effacer**.
- Le WAV fait environ 5,8 Mo par minute.
