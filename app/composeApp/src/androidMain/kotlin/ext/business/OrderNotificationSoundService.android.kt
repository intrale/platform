package ext.business

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import asdo.business.OrderSoundConfig
import asdo.business.OrderSoundType

/**
 * Implementacion Android del servicio de sonido para notificaciones de pedidos.
 * Usa ToneGenerator para sonidos simples y Vibrator para vibracion.
 */
actual class OrderNotificationSoundService actual constructor() {

    private var toneGenerator: ToneGenerator? = null
    private var isPlaying = false

    actual fun playNotificationSound(config: OrderSoundConfig) {
        if (!config.enabled || config.isMuted) return

        stopSound()

        try {
            val volume = (config.volume * TONE_MAX_VOLUME).toInt()
                .coerceIn(TONE_MIN_VOLUME, TONE_MAX_VOLUME)

            val toneType = when (config.soundType) {
                OrderSoundType.DEFAULT -> ToneGenerator.TONE_PROP_BEEP
                OrderSoundType.BELL -> ToneGenerator.TONE_PROP_BEEP2
                OrderSoundType.CHIME -> ToneGenerator.TONE_PROP_ACK
                OrderSoundType.URGENT -> ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD
            }

            toneGenerator = ToneGenerator(AudioManager.STREAM_NOTIFICATION, volume)
            toneGenerator?.startTone(toneType, TONE_DURATION_MS)
            isPlaying = true
        } catch (_: Exception) {
            // ToneGenerator puede fallar en algunos dispositivos
            isPlaying = false
        }
    }

    actual fun stopSound() {
        try {
            toneGenerator?.stopTone()
            toneGenerator?.release()
            toneGenerator = null
            isPlaying = false
        } catch (_: Exception) {
            // Ignorar errores al detener
        }
    }

    @Suppress("DEPRECATION")
    actual fun vibrate(config: OrderSoundConfig) {
        if (!config.vibrationEnabled || config.isMuted) return

        try {
            val context = AndroidContextProvider.context ?: return
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vibratorManager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vibratorManager?.defaultVibrator
            } else {
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }

            vibrator?.let {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val effect = VibrationEffect.createWaveform(
                        VIBRATION_PATTERN,
                        VIBRATION_NO_REPEAT
                    )
                    it.vibrate(effect)
                } else {
                    it.vibrate(VIBRATION_PATTERN, VIBRATION_NO_REPEAT)
                }
            }
        } catch (_: Exception) {
            // Ignorar errores de vibracion
        }
    }

    actual fun release() {
        stopSound()
    }

    actual fun isAvailable(): Boolean = true

    companion object {
        private const val TONE_DURATION_MS = 500
        private const val TONE_MAX_VOLUME = 100
        private const val TONE_MIN_VOLUME = 0
        private const val VIBRATION_NO_REPEAT = -1
        private val VIBRATION_PATTERN = longArrayOf(0L, 200L, 100L, 200L, 100L, 300L)
    }
}

/**
 * Proveedor de contexto Android para servicios que lo necesitan.
 * Se inicializa desde MainActivity.
 */
object AndroidContextProvider {
    var context: Context? = null
        private set

    fun initialize(context: Context) {
        this.context = context.applicationContext
    }
}
