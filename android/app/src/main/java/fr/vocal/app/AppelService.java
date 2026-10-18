package fr.vocal.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.VolumeProvider;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * Service au premier plan (notification permanente) : Android laisse le micro et l'appel actifs
 * écran éteint. Il tient aussi une session média qui capte les boutons de volume quand l'appli
 * n'est pas au premier plan, pour envoyer le vocal même écran éteint (selon les téléphones).
 */
public class AppelService extends Service {

    private static final String CANAL = "appel";
    private MediaSession session;

    @Override
    public int onStartCommand(Intent intent, int flags, int id) {
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(
                new NotificationChannel(CANAL, "Appel en cours", NotificationManager.IMPORTANCE_LOW));
        PendingIntent ouvrir = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CANAL)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("Appel en cours")
                .setContentText("Bouton volume : envoyer le vocal")
                .setContentIntent(ouvrir)
                .setOngoing(true)
                .build();

        if (Build.VERSION.SDK_INT >= 30) {
            startForeground(1, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else if (Build.VERSION.SDK_INT == 29) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(1, notification);
        }

        if (session == null) demarrerSession();
        return START_NOT_STICKY;
    }

    private void demarrerSession() {
        session = new MediaSession(this, "vocal");
        // Sans callback, Android jette en silence les appuis destinés à la session (volume compris).
        // Le bouton pause/lecture des écouteurs envoie aussi le vocal.
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                envoyer("bouton des écouteurs");
            }

            @Override
            public void onPause() {
                envoyer("bouton des écouteurs");
            }

            @Override
            public void onSkipToNext() {
                envoyer("bouton des écouteurs");
            }
        });
        session.setPlaybackToRemote(new VolumeProvider(VolumeProvider.VOLUME_CONTROL_RELATIVE, 100, 50) {
            @Override
            public void onAdjustVolume(int direction) {
                if (direction != 0) envoyer("écran éteint");  // 0 : bouton relâché
            }
        });
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT)
                .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                .build());
        session.setActive(true);
    }

    private void envoyer(String origine) {
        MainActivity activite = MainActivity.instance;
        if (activite != null) activite.envoyerVocal(origine);
        else Log.w(MainActivity.TAG, "Bouton (" + origine + ") reçu, mais l'appli est fermée");
    }

    @Override
    public void onTaskRemoved(Intent intent) {
        stopSelf();  // appli fermée depuis les applis récentes : on raccroche
    }

    @Override
    public void onDestroy() {
        if (session != null) session.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
