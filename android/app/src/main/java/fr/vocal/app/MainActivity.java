package fr.vocal.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.GestureDetector;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;

/**
 * Affiche la page téléphone du site et lui ajoute ce qu'un site ne peut pas faire :
 * les boutons de volume envoient le vocal, et l'appel continue écran éteint (voir AppelService).
 */
public class MainActivity extends Activity {

    private static final String ADRESSE = "https://mansournatsaev-bit.github.io/vocal/tel.html";
    private static final int DEMANDE_MEDIA = 1;
    static final String TAG = "Vocal";

    /** Le service passe par ici pour transmettre le bouton volume quand l'écran est éteint. */
    static MainActivity instance;

    private FrameLayout racine;
    private WebView web;
    private View voileNoir;
    private PermissionRequest demandeMedia;  // demande de la page en attente de la réponse d'Android
    private String adresse = ADRESSE;
    private boolean relanceEnCours;
    private final Handler principal = new Handler(Looper.getMainLooper());
    private final Runnable couperSon = this::couperSonMaintenant;
    private final Runnable sortieSco = () -> sortirDuSco();
    private AudioDeviceCallback ecouteCasques;
    private Object ecouteCommunication;  // AudioManager.OnCommunicationDeviceChangedListener (Android 12+)

    @Override
    protected void onCreate(Bundle etat) {
        super.onCreate(etat);
        instance = this;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Version de test uniquement : on peut lui donner l'adresse d'un serveur local.
        String adresseTest = enTest() ? getIntent().getStringExtra("adresse") : null;
        if (adresseTest != null && adresseTest.startsWith("http://localhost:")) adresse = adresseTest;
        web = creerWebView();

        // Écran noir : l'écran reste allumé au minimum, donc les boutons de volume marchent toujours.
        // Double-toucher pour revenir.
        voileNoir = new View(this);
        voileNoir.setBackgroundColor(Color.BLACK);
        voileNoir.setVisibility(View.GONE);
        GestureDetector doubleToucher = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDoubleTap(MotionEvent e) {
                ecranNoir(false);
                return true;
            }
        });
        voileNoir.setOnTouchListener((v, e) -> {
            doubleToucher.onTouchEvent(e);
            return true;
        });

        racine = new FrameLayout(this);
        racine.addView(web);
        racine.addView(voileNoir);
        setContentView(racine);

        if (microAutorise()) demarrerService();
        else requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, DEMANDE_MEDIA);
        surveillerCasques();
        chargerPage();
    }

    /**
     * Toujours la dernière version de la page : le site autorise à la garder 10 min en mémoire, ce qui
     * affichait l'ancienne version après une mise à jour. Ses fichiers (?v=…) restent en mémoire.
     */
    private void chargerPage() {
        web.loadUrl(adresse + (adresse.contains("?") ? "&" : "?") + "t=" + System.currentTimeMillis());
    }

    private WebView creerWebView() {
        WebView vue = new WebView(this);
        // La page doit continuer à tourner écran éteint (enregistrement, envoi) : priorité haute même invisible.
        vue.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        WebSettings reglages = vue.getSettings();
        reglages.setJavaScriptEnabled(true);
        reglages.setDomStorageEnabled(true);
        // Le son de l'appel et le bip démarrent sans toucher l'écran.
        reglages.setMediaPlaybackRequiresUserGesture(false);
        vue.addJavascriptInterface(new Pont(), "VocalNatif");
        vue.setWebViewClient(new WebViewClient());
        vue.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.i(TAG, "Page : " + message.message());
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest demande) {
                Log.i(TAG, "La page demande : " + String.join(", ", demande.getResources()));
                runOnUiThread(() -> {
                    if (!siteAutorise(demande.getOrigin())) {
                        demande.deny();
                        return;
                    }
                    String[] manquantes = permissionsManquantes(demande.getResources());
                    if (manquantes.length == 0) {
                        demande.grant(demande.getResources());
                        Log.i(TAG, "Accordé à la page");
                        if (demandeMicro(demande)) planifierSortieSco(500);
                    } else {
                        demandeMedia = demande;
                        requestPermissions(manquantes, DEMANDE_MEDIA);
                    }
                });
            }
        });
        return vue;
    }

    /**
     * Rappel depuis le bouton volume. Une page restée longtemps cachée (écran éteint) n'obtient plus le
     * micro : le moteur web ne la réveille presque plus. On la remplace par une page neuve, qui démarre
     * l'appel tout de suite comme au lancement de l'appli. Le petit délai laisse finir le son de rappel.
     */
    void relancer() {
        if (relanceEnCours) return;
        relanceEnCours = true;
        Log.i(TAG, "Rappel : nouvelle page");
        racine.postDelayed(() -> {
            relanceEnCours = false;
            WebView ancienne = web;
            web = creerWebView();
            racine.addView(web, 0);
            racine.removeView(ancienne);
            ancienne.destroy();
            chargerPage();
        }, 700);
    }

    private boolean enTest() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    /** Seul le site de l'appli (ou le serveur local en version de test) a droit au micro et à la caméra. */
    private boolean siteAutorise(Uri origine) {
        String hote = origine.getHost();
        return "mansournatsaev-bit.github.io".equals(hote) || (enTest() && "localhost".equals(hote));
    }

    private boolean microAutorise() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** Permissions Android encore à demander pour ce que veut la page : micro et/ou caméra (photos). */
    private String[] permissionsManquantes(String[] ressources) {
        List<String> manquantes = new ArrayList<>();
        for (String ressource : ressources) {
            String permission = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(ressource) ? Manifest.permission.RECORD_AUDIO
                    : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(ressource) ? Manifest.permission.CAMERA
                    : null;
            if (permission != null && checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                manquantes.add(permission);
            }
        }
        return manquantes.toArray(new String[0]);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] resultats) {
        if (code != DEMANDE_MEDIA) return;
        if (microAutorise()) demarrerService();
        if (demandeMedia != null) {
            if (permissionsManquantes(demandeMedia.getResources()).length == 0) {
                demandeMedia.grant(demandeMedia.getResources());
                if (demandeMicro(demandeMedia)) planifierSortieSco(500);
            } else demandeMedia.deny();
            demandeMedia = null;
        }
    }

    private void demarrerService() {
        startForegroundService(new Intent(this, AppelService.class));
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent evenement) {
        if (estVolume(code)) {
            if (evenement.getRepeatCount() == 0) envoyerVocal("écran allumé");
            return true;  // le volume ne bouge pas : le bouton sert à envoyer
        }
        return super.onKeyDown(code, evenement);
    }

    @Override
    public boolean onKeyUp(int code, KeyEvent evenement) {
        return estVolume(code) || super.onKeyUp(code, evenement);
    }

    private static boolean estVolume(int code) {
        return code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN;
    }

    /** Même effet que le gros bouton Envoyer, avec le bip de confirmation. Le résultat va dans le journal. */
    void envoyerVocal(String origine) {
        Log.i(TAG, "Bouton (" + origine + ") reçu");
        runOnUiThread(() -> web.evaluateJavascript(
                "window.vocalEnvoyer ? window.vocalEnvoyer() : 'page pas prête'",
                resultat -> Log.i(TAG, "Bouton (" + origine + ") → " + resultat)));
    }

    void ecranNoir(boolean actif) {
        voileNoir.setVisibility(actif ? View.VISIBLE : View.GONE);
        WindowManager.LayoutParams p = getWindow().getAttributes();
        p.screenBrightness = actif ? 0.01f : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
        getWindow().setAttributes(p);
        getWindow().getDecorView().setSystemUiVisibility(actif
                ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                : 0);
    }

    // ---------- Casque Bluetooth : écouter dans le casque, parler dans le micro du téléphone ----------
    // Dès que la page prend le micro, le moteur web passe l'appel en Bluetooth « mains libres » (SCO) :
    // le micro devient celui du casque, en 16 kHz. On sort de ce mode pour garder le micro du téléphone
    // (48 kHz) ; le son de l'ordinateur reste dans le casque, en qualité musique (A2DP).

    private static boolean demandeMicro(PermissionRequest demande) {
        for (String r : demande.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) return true;
        return false;
    }

    private static boolean estBluetooth(int type) {
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                || type == 26 /* TYPE_BLE_HEADSET */;
    }

    private static boolean estMainsLibres(int type) {
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == 26 /* TYPE_BLE_HEADSET */;
    }

    private boolean casqueConnecte() {
        for (AudioDeviceInfo d : getSystemService(AudioManager.class).getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (estBluetooth(d.getType())) return true;
        }
        return false;
    }

    private void planifierSortieSco(int delai) {
        principal.removeCallbacks(sortieSco);
        principal.postDelayed(sortieSco, delai);
    }

    /** Sans casque Bluetooth, rien ne change. */
    private void sortirDuSco() {
        if (!casqueConnecte()) return;
        AudioManager audio = getSystemService(AudioManager.class);
        try {
            if (Build.VERSION.SDK_INT >= 31) AudioManager.class.getMethod("clearCommunicationDevice").invoke(audio);
            else audio.stopBluetoothSco();
        } catch (Exception e) {
            Log.w(TAG, "Casque : sortie du mode mains libres impossible", e);
        }
        if (audio.getMode() != AudioManager.MODE_NORMAL) audio.setMode(AudioManager.MODE_NORMAL);
        Log.i(TAG, "Casque : micro du téléphone, mode " + audio.getMode() + ", appareil d'appel " + appareilAppel(audio));
    }

    private static String appareilAppel(AudioManager audio) {
        if (Build.VERSION.SDK_INT < 31) return "?";
        try {
            AudioDeviceInfo d = (AudioDeviceInfo) AudioManager.class.getMethod("getCommunicationDevice").invoke(audio);
            return d == null ? "aucun" : String.valueOf(d.getType());
        } catch (Exception e) {
            return "?";
        }
    }

    /**
     * À chaque casque connecté, et chaque fois que le moteur web remet l'appel sur le casque en mains
     * libres (Android 12+), on en ressort.
     */
    private void surveillerCasques() {
        AudioManager audio = getSystemService(AudioManager.class);
        ecouteCasques = new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] ajoutes) {
                for (AudioDeviceInfo d : ajoutes) {
                    if (estBluetooth(d.getType())) {
                        planifierSortieSco(500);
                        return;
                    }
                }
            }
        };
        audio.registerAudioDeviceCallback(ecouteCasques, principal);

        if (Build.VERSION.SDK_INT < 31) return;
        try {
            Class<?> type = Class.forName("android.media.AudioManager$OnCommunicationDeviceChangedListener");
            ecouteCommunication = Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] { type }, (moi, methode, args) -> {
                switch (methode.getName()) {
                    case "onCommunicationDeviceChanged":
                        AudioDeviceInfo d = (AudioDeviceInfo) args[0];
                        Log.i(TAG, "Casque : appareil d'appel → " + (d == null ? "aucun" : d.getType()));
                        if (d != null && estMainsLibres(d.getType())) planifierSortieSco(300);
                        return null;
                    case "hashCode": return System.identityHashCode(moi);
                    case "equals": return moi == args[0];
                    case "toString": return "ecouteCommunication";
                    default: return null;
                }
            });
            AudioManager.class.getMethod("addOnCommunicationDeviceChangedListener", Executor.class, type)
                    .invoke(audio, getMainExecutor(), ecouteCommunication);
        } catch (Exception e) {
            Log.w(TAG, "Casque : surveillance impossible", e);
        }
    }

    private void arreterSurveillanceCasques() {
        AudioManager audio = getSystemService(AudioManager.class);
        principal.removeCallbacks(sortieSco);
        if (ecouteCasques != null) audio.unregisterAudioDeviceCallback(ecouteCasques);
        if (ecouteCommunication == null) return;
        try {
            Class<?> type = Class.forName("android.media.AudioManager$OnCommunicationDeviceChangedListener");
            AudioManager.class.getMethod("removeOnCommunicationDeviceChangedListener", type).invoke(audio, ecouteCommunication);
        } catch (Exception ignore) {
        }
    }

    // ---------- Téléphone muet quand l'appel est raccroché ----------

    /** Muet dans `delai` ms (le temps de jouer le son de fin d'appel), sauf si l'appel revient avant. */
    void couperSon(int delai) {
        principal.removeCallbacks(couperSon);
        principal.postDelayed(couperSon, delai);
    }

    /**
     * Multimédia à 0 (son de l'appel, bips, vidéos…) et sonnerie coupée, ce qui coupe aussi les
     * notifications et les sons du système. Sans l'accès « Ne pas déranger », Android n'autorise que le
     * vibreur. Les réglages d'avant sont gardés, même si l'appli est fermée entre-temps.
     */
    private synchronized void couperSonMaintenant() {
        AudioManager audio = getSystemService(AudioManager.class);
        SharedPreferences memo = getSharedPreferences("son", MODE_PRIVATE);
        if (!memo.getBoolean("coupe", false)) {
            memo.edit()
                    .putBoolean("coupe", true)
                    .putInt("sonnerie", audio.getRingerMode())
                    .putInt("multimedia", audio.getStreamVolume(AudioManager.STREAM_MUSIC))
                    .commit();
        }
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, 0, 0);
        boolean muetPermis = getSystemService(NotificationManager.class).isNotificationPolicyAccessGranted();
        try {
            audio.setRingerMode(muetPermis ? AudioManager.RINGER_MODE_SILENT : AudioManager.RINGER_MODE_VIBRATE);
        } catch (SecurityException e) {
            Log.w(TAG, "Sonnerie : " + e.getMessage());
        }
        Log.i(TAG, "Raccroché : sonnerie " + audio.getRingerMode() + ", multimédia à 0");
    }

    /** Remet le son d'avant le raccrochage (et annule le passage en muet s'il n'a pas encore eu lieu). */
    synchronized void remettreSon() {
        principal.removeCallbacks(couperSon);
        SharedPreferences memo = getSharedPreferences("son", MODE_PRIVATE);
        if (!memo.getBoolean("coupe", false)) return;
        AudioManager audio = getSystemService(AudioManager.class);
        try {
            audio.setRingerMode(memo.getInt("sonnerie", AudioManager.RINGER_MODE_NORMAL));
        } catch (SecurityException e) {
            Log.w(TAG, "Sonnerie : " + e.getMessage());
        }
        audio.setStreamVolume(AudioManager.STREAM_MUSIC,
                memo.getInt("multimedia", audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC) / 2), 0);
        memo.edit().putBoolean("coupe", false).commit();
        Log.i(TAG, "Rappel : son d'avant remis");
    }

    @Override
    public void onBackPressed() {
        if (voileNoir.getVisibility() == View.VISIBLE) ecranNoir(false);
        else moveTaskToBack(true);  // retour : l'appli passe derrière, l'appel continue
    }

    @Override
    protected void onDestroy() {
        if (instance == this) instance = null;
        remettreSon();  // appli fermée : le téléphone retrouve son son
        arreterSurveillanceCasques();
        stopService(new Intent(this, AppelService.class));
        web.destroy();
        super.onDestroy();
    }

    /** Fonctions appelables depuis la page : window.VocalNatif. */
    private class Pont {
        @JavascriptInterface
        public void ecranNoir() {
            runOnUiThread(() -> MainActivity.this.ecranNoir(true));
        }

        @JavascriptInterface
        public void relancer() {
            runOnUiThread(MainActivity.this::relancer);
        }

        @JavascriptInterface
        public void couperSon(int delai) {
            MainActivity.this.couperSon(delai);
        }

        // Tout de suite (pas via le fil principal) : le son de rappel qui suit doit s'entendre.
        @JavascriptInterface
        public void remettreSon() {
            MainActivity.this.remettreSon();
        }

        // Réglage du volume depuis la page : les boutons de volume servent à envoyer le vocal.
        // Le son de l'appel et les bips passent par le volume multimédia.

        @JavascriptInterface
        public int volume() {
            AudioManager audio = getSystemService(AudioManager.class);
            int min = volumeMin(audio), max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            return Math.round(100f * (audio.getStreamVolume(AudioManager.STREAM_MUSIC) - min) / (max - min));
        }

        @JavascriptInterface
        public int reglerVolume(int pourcent) {
            AudioManager audio = getSystemService(AudioManager.class);
            int min = volumeMin(audio), max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            int cran = min + Math.round(Math.max(0, Math.min(100, pourcent)) / 100f * (max - min));
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, cran, 0);
            return volume();
        }

        @JavascriptInterface
        public int changerVolume(int sens) {
            getSystemService(AudioManager.class).adjustStreamVolume(AudioManager.STREAM_MUSIC,
                    sens > 0 ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER, 0);
            return volume();
        }

        private int volumeMin(AudioManager audio) {
            return Build.VERSION.SDK_INT >= 28 ? audio.getStreamMinVolume(AudioManager.STREAM_MUSIC) : 0;
        }
    }
}
