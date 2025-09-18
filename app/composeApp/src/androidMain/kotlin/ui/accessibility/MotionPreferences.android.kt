package ui.accessibility

import android.animation.ValueAnimator
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

@Composable
actual fun rememberMotionPreferences(): MotionPreferences {
    val context = LocalContext.current
    val contentResolver = context.contentResolver
    var reduceMotion by remember { mutableStateOf(!ValueAnimator.areAnimatorsEnabled()) }

    DisposableEffect(contentResolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                reduceMotion = !ValueAnimator.areAnimatorsEnabled()
            }
        }
        val uri = Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE)
        contentResolver.registerContentObserver(uri, false, observer)
        reduceMotion = !ValueAnimator.areAnimatorsEnabled()
        onDispose {
            contentResolver.unregisterContentObserver(observer)
        }
    }

    return MotionPreferences(reduceMotion = reduceMotion)
}
