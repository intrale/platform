package ui.deeplink

import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ar.com.intrale.BuildConfig
import ar.com.intrale.MainActivity
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeeplinkHostIntentFilterTest {

    @Test
    fun deeplinkIntentResolvesWithDynamicHost() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val deeplinkUri = Uri.parse("https://${BuildConfig.DEEPLINK_HOST}/test")
        val deeplinkIntent = Intent(Intent.ACTION_VIEW, deeplinkUri).apply {
            addCategory(Intent.CATEGORY_DEFAULT)
            addCategory(Intent.CATEGORY_BROWSABLE)
            setPackage(context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        val resolveInfos = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.packageManager.queryIntentActivities(
                deeplinkIntent,
                PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong())
            )
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.queryIntentActivities(
                deeplinkIntent,
                PackageManager.MATCH_DEFAULT_ONLY
            )
        }

        assertTrue(resolveInfos.isNotEmpty(), "No se pudo resolver el intent de deeplink para el host configurado.")

        val matchesMainActivity = resolveInfos.any { it.activityInfo?.name == MainActivity::class.java.name }
        assertTrue(matchesMainActivity, "El deeplink no está apuntando a MainActivity.")

        val hostMatches = resolveInfos.any { resolveInfo ->
            val filter: IntentFilter = resolveInfo.filter ?: return@any false
            val iterator = filter.authoritiesIterator() ?: return@any false
            while (iterator.hasNext()) {
                if (iterator.next().host == BuildConfig.DEEPLINK_HOST) {
                    return@any true
                }
            }
            false
        }
        assertTrue(hostMatches, "El intent-filter no declara el host dinámico ${BuildConfig.DEEPLINK_HOST}.")

        val launchedActivity = instrumentation.startActivitySync(deeplinkIntent)
        try {
            assertEquals(
                MainActivity::class.java.name,
                launchedActivity::class.java.name,
                "El deeplink no abre la actividad esperada."
            )
        } finally {
            instrumentation.runOnMainSync { launchedActivity.finish() }
        }
    }
}
