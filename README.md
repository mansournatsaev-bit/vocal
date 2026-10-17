# Vocal

Un seul lien : **https://mansournatsaev-bit.github.io/vocal**

On l'ouvre et on est en appel, sur le téléphone comme sur l'ordinateur. Rien à envoyer, rien à
cliquer pour rejoindre.

- **Téléphone** : l'appel démarre tout seul et le micro est enregistré en continu, en qualité
  maximale. Le gros bouton **Envoyer** (tiers bas de l'écran) envoie à l'ordinateur un fichier WAV
  avec tout ce qui a été dit depuis l'appui précédent. Au bout de 3 minutes sans appui, le vocal
  part tout seul et l'enregistrement continue sans trou dans le suivant.
- **Ordinateur** : on entend l'appel et on parle. Le tiers haut de l'écran annonce « Tu as reçu un
  vocal ». Les vocaux arrivent dans l'ordre : clic = télécharger, glisser = le déposer où on veut
  (bureau, dossier, page web). **Tout effacer** vide la liste. À gauche, pendant l'appel :
  **Photographier** fait prendre et envoyer une photo au téléphone, **Récupérer le vocal** (avec la
  durée en cours) fait comme un appui sur Envoyer.
- **Photo d'une feuille** (téléphone) : appareil photo en mode document, avec un cadre A4, la mise
  au point et l'exposition réglées pour du papier, et une photo en pleine définition. La photo part
  dès qu'on appuie, après le traitement « scan » qui blanchit le papier, efface les ombres et fonce
  l'écriture (les couleurs restent). Rester immobile tant que « Ne bouge pas… » est affiché. Sur
  l'ordinateur, la photo arrive dans la même liste : clic = l'ouvrir en grand, glisser = la déposer.
- L'appli du téléphone ne fait aucun son à elle : on n'entend que l'ordinateur.
- **Lire un texte au téléphone** (ordinateur, colonne de droite) : on colle un texte, **Lire** le fait
  dire par une voix de synthèse envoyée dans l'appel, donc entendue sur le téléphone (pas dans les
  haut-parleurs de l'ordinateur). Ce qui a été lu change de couleur, la vitesse se règle de 0,1 à 1 ×
  pendant la lecture, et un clic sur un mot reprend à cet endroit. La voix (Piper, libre) est calculée
  dans le navigateur : le texte ne part nulle part. Elle est téléchargée une fois (63 Mo).
  **Dictée** (case cochée) : à chaque point, la voix dit « point » puis attend 3 secondes.
  **Pause tous les N mots** : la voix s'arrête après chaque groupe de mots (5 par défaut), le temps
  choisi en secondes ; la durée se change même pendant la lecture.
  Le bouton **Micro** en haut de la page coupe le micro de l'ordinateur : le téléphone n'entend alors
  que le texte lu.
  Le bouton **Entraînement** (en haut à droite) raccroche et coupe toute liaison avec le téléphone :
  la dictée sort alors sur les haut-parleurs de l'ordinateur, sans rien consommer sur le relais.
  Recliquer dessus reprend l'appel.

## Appli Android (bouton volume)

Un site ne peut pas utiliser les boutons de volume. L'appli **Vocal** (`vocal.apk`, à installer depuis
https://mansournatsaev-bit.github.io/vocal/vocal.apk) affiche la même page téléphone et ajoute :

- **volume + ou volume −** envoie le vocal, écran allumé comme écran éteint ;
- le bouton pause/lecture des écouteurs envoie aussi le vocal ;
- l'appel et l'enregistrement continuent écran éteint (notification « Appel en cours ») ;
- le bouton **Écran noir** garde l'appel en cachant l'écran (double-toucher pour revenir) ;
- **raccrocher rend le téléphone muet** : multimédia à 0, sonnerie, notifications et sons du système
  coupés (vibreur, ou muet complet si Vocal a l'accès « Ne pas déranger »). Au rappel, ou quand on
  ferme l'appli, tout revient comme avant. Les alarmes ne sont pas touchées.

Pour quitter, balayer l'appli dans les applis récentes : ça raccroche. La touche Accueil la laisse tourner.

Pas de serveur à installer : l'appel et les fichiers passent directement d'un appareil à l'autre
(WebRTC, via le service gratuit PeerJS pour la mise en relation). Il y a un seul appel par site :
un téléphone et un ordinateur à la fois. N'importe quel ordinateur peut servir : il suffit d'y
ouvrir le lien (et de fermer la page sur l'ancien).

Quand le téléphone est en 4G/5G, ou sur un autre réseau que l'ordinateur, le direct est souvent
impossible : l'appel passe alors par un relais TURN (ExpressTURN, offre gratuite de 1000 Go/mois,
identifiants dans `ICE_SERVERS` de `commun.js`). À la maison, sur la même box, rien ne passe par
le relais.

## À savoir

- La première fois, le navigateur demande l'accès au micro.
- Les navigateurs coupent le son tant qu'on n'a pas touché la page : si un message le demande, un
  toucher n'importe où suffit.
- Mets des écouteurs sur le téléphone, sinon l'ordinateur s'entend en écho (le micro est enregistré
  brut, sans anti-écho).
- Garde l'appli au premier plan sur le téléphone, l'écran reste allumé tout seul.
- Un vocal non reçu reste sur le téléphone et repart dès que l'ordinateur est de nouveau là.
- Le WAV fait environ 5,8 Mo par minute.
