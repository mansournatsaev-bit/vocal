# Compiler l'appli Android Vocal

Code source de l'appli `fr.vocal.app` (le site est à la racine du dépôt, sur `main`).
Ce dossier recompile la **version 2.1** (versionName `2.1`, versionCode `12`).

## Outils utilisés

| Outil | Version | Où sur le premier PC |
|---|---|---|
| JDK | Eclipse Temurin **17.0.20.8** (Adoptium) | `C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot` |
| SDK Android | plateforme **android-30**, build-tools **30.0.3** | `%LOCALAPPDATA%\Android\Sdk` |
| Gradle | **8.11.1** (téléchargé par `gradlew`) | — |
| Plugin Android (AGP) | **8.0.2** (téléchargé par Gradle) | — |

`compileSdk 30`, `targetSdk 30`, `minSdk 26`, Java 11 pour le code. Rien d'autre à installer :
pas d'Android Studio, pas d'AndroidX.

Le SDK s'installe avec les outils en ligne de commande d'Android (`sdkmanager`) :

```bat
sdkmanager "platforms;android-30" "build-tools;30.0.3" "platform-tools"
```

## Fichiers à ajouter avant de compiler (jamais publiés)

À côté de `settings.gradle`, dans ce dossier `android/` :

1. **`local.properties`** : l'emplacement du SDK sur ce PC, par exemple
   `sdk.dir=C\:\\Users\\<toi>\\AppData\\Local\\Android\\Sdk`
2. **`vocal.keystore`** : la clé de signature (à copier depuis le premier PC, voir plus bas).
3. **`signature.properties`** : ses mots de passe, deux lignes :
   ```
   storePassword=...
   keyPassword=...
   ```
   (À la place de ce fichier, on peut définir les variables d'environnement `VOCAL_STORE_PASSWORD`
   et `VOCAL_KEY_PASSWORD`.)

Ces fichiers sont dans `.gitignore`.

## Commande de compilation

Dans ce dossier `android/`, avec le JDK 17 :

```bat
set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot
gradlew.bat assembleRelease --no-daemon
```

L'APK signé sort dans `app\build\outputs\apk\release\app-release.apk`. Pour le site, il est copié à
la racine du dépôt sous le nom `vocal.apk`.

Vérifier la version et la signature :

```bat
%LOCALAPPDATA%\Android\Sdk\build-tools\30.0.3\aapt.exe dump badging app\build\outputs\apk\release\app-release.apk | findstr package:
%LOCALAPPDATA%\Android\Sdk\build-tools\30.0.3\apksigner.bat verify --print-certs app\build\outputs\apk\release\app-release.apk
```

Attendu : `versionCode='12' versionName='2.1'` et le certificat
`SHA-256 8c7a9a6111ece793ccb635c3b18dcac4b5dee9110862ec437f3af6f0c7ce9acf` (`CN=Vocal`).

## Signature

- **Ce n'est pas la clé debug d'Android Studio.** C'est une clé faite exprès pour Vocal avec `keytool`.
  Elle est au format PKCS12, a pour alias **`vocal`** et utilise SHA256withRSA. Elle est valable
  jusqu'en 2054.
- Toutes les versions de l'appli sont signées avec cette clé. **Il faut la même clé** pour que la
  nouvelle version s'installe par-dessus l'ancienne. Avec une autre clé, Android refuse la mise à
  jour : il faut alors désinstaller l'appli, ce qui efface ses réglages.
- Sur le premier PC, la clé est dans le dossier de la session Claude, à côté de ce projet :
  `C:\Users\6600k\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\scratch-workspaces\77d13345-2881-4ded-a995-0ad1471534c1\65c4aab7-21cd-4478-92ad-d8fcdb767263\scratch-2026-10-01-ccc846\vocal-android\vocal.keystore`.
  Son fichier `signature.properties`, qui contient les mots de passe, est juste à côté. Copie les
  deux par clé USB.
  **Ce dossier est effacé si la session est supprimée** : garde une copie de la clé ailleurs.
- La configuration de signature est dans `app/build.gradle` (`signingConfigs.maison`).
