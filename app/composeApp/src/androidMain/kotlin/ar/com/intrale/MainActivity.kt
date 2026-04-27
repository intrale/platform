package ar.com.intrale

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.tooling.preview.Preview
import ext.location.AndroidLocationProvider
import ext.location.LocationProviderHolder
import ext.push.AndroidPushNotificationDisplay
import ext.push.PushDeepLinkStore
import ui.App
import ui.sc.client.AddressCheckStore

class MainActivity : ComponentActivity() {
    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Inicializar canales de notificacion push
        AndroidPushNotificationDisplay(this).initializeChannels()

        // Registrar el proveedor de ubicación Android para el flujo de
        // verificación de zona (issue #2422). El holder solo guarda la
        // referencia; ninguna coordenada se persiste.
        LocationProviderHolder.set(AndroidLocationProvider(applicationContext))

        // Procesar deep link si viene de una notificacion push
        handlePushDeepLink(intent)

        setContent {
            Box(modifier = Modifier.semantics { testTagsAsResourceId = true }) {
                App()
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        handlePushDeepLink(intent)
    }

    /**
     * Watchdog de privacidad (CA-5): si la app pasó más de
     * [AddressCheckStore.BACKGROUND_TIMEOUT_MS] en background, descartamos
     * la verificación de zona en memoria. La próxima vez que el usuario
     * vea el catálogo, el banner pedirá verificar de nuevo.
     */
    override fun onResume() {
        super.onResume()
        AddressCheckStore.maybeClearOnResume(System.currentTimeMillis())
    }

    private fun handlePushDeepLink(intent: android.content.Intent?) {
        if (intent?.getBooleanExtra("fromPush", false) == true) {
            val orderId = intent.getStringExtra("orderId")
            if (!orderId.isNullOrBlank()) {
                PushDeepLinkStore.setPendingOrderNavigation(orderId)
            }
        }
    }
}

@Preview
@Composable
fun AppAndroidPreview() {
    App()
}