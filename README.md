# Vocal

Un seul lien : **https://mansournatsaev-bit.github.io/vocal**

On l'ouvre et on est en appel, sur le téléphone comme sur l'ordinateur. Rien à envoyer, rien à
cliquer pour rejoindre.

- **Téléphone** : l'appel démarre tout seul et le micro est enregistré en continu, en qualité
  maximale. Le gros bouton **Envoyer** (tiers bas de l'écran) envoie à l'ordinateur un fichier WAV
  avec tout ce qui a été dit depuis l'appui précédent. Un vocal fait forcément moins de 5 minutes :
  à 5 minutes sans envoi, tout est effacé (« Effacé (5 min) ») et le compteur repart de 0.
- **Ordinateur** : on entend l'appel et on parle. Le tiers haut de l'écran annonce « Tu as reçu un
  vocal ». Les vocaux arrivent dans l'ordre : clic = télécharger, glisser = le déposer où on veut
  (bureau, dossier, page web). **Tout effacer** vide la liste.

## Appli Android (bouton volume)

Un site ne peut pas utiliser les boutons de volume. L'appli **Vocal** (`vocal.apk`, à installer depuis
https://mansournatsaev-bit.github.io/vocal/vocal.apk) affiche la même page téléphone et ajoute :

- **volume + ou volume −** envoie le vocal, écran allumé comme écran éteint (bip-bip = envoyé) ;
- le bouton pause/lecture des écouteurs envoie aussi le vocal ;
- l'appel et l'enregistrement continuent écran éteint (notification « Appel en cours ») ;
- le bouton **Écran noir** garde l'appel en cachant l'écran (double-toucher pour revenir).

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
