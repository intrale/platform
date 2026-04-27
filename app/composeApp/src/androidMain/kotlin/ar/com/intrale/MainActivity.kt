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
import ext.business.AppContextHolder
import ext.push.AndroidPushNotificationDisplay
import ext.push.PushDeepLinkStore
import ui.App

class MainActivity : ComponentActivity() {
    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Inicializar holder del Application Context — usado por servicios de larga vida
        // que se instancian en DI (ej. AndroidDeliveryZonesCache con DataStore en #2420).
        AppContextHolder.init(applicationContext)

        // Inicializar canales de notificacion push
        AndroidPushNotificationDisplay(this).initializeChannels()

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