package ui.cp

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.business.ActiveSoundAlert
import asdo.business.OrderSoundConfig
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import ext.business.OrderNotificationSoundService
import kotlinx.coroutines.delay
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.business.BusinessOrderNotificationStore
import ui.th.spacing

private val logger = LoggerFactory.default.newLogger("ui.cp", "OrderSoundAlertBanner")

/**
 * Banner que se muestra en la parte superior cuando hay pedidos nuevos pendientes.
 * Reproduce sonido periodicamente segun la configuracion.
 */
@Composable
fun OrderSoundAlertBanner(
    onDismissAll: () -> Unit = { BusinessOrderNotificationStore.dismissAllAlerts() },
    onOrderClick: (String) -> Unit = {}
) {
    val alerts by BusinessOrderNotificationStore.activeAlerts.collectAsState()
    val config by BusinessOrderNotificationStore.config.collectAsState()
    val soundService = remember { OrderNotificationSoundService() }

    // Efecto para reproducir sonido periodicamente
    LaunchedEffect(alerts, config) {
        if (alerts.isEmpty()) return@LaunchedEffect
        if (!config.enabled || config.isMuted) return@LaunchedEffect

        while (true) {
            logger.info { "Reproduciendo sonido de alerta (${alerts.size} pedidos pendientes)" }
            soundService.playNotificationSound(config)
            soundService.vibrate(config)
            delay(config.repeatIntervalSeconds.toLong() * MILLIS_PER_SECOND)
        }
    }

    // Limpiar recursos al desmontar
    DisposableEffect(Unit) {
        onDispose {
            soundService.stopSound()
            soundService.release()
        }
    }

    AnimatedVisibility(
        visible = alerts.isNotEmpty(),
        enter = slideInVertically() + fadeIn(),
        exit = slideOutVertically() + fadeOut()
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x2),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.primaryContainer
            )
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x3),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = Txt(MessageKey.business_notification_sound_title),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onPrimaryContainer
                    )
                    Row {
                        MuteButton(config = config)
                        TextButton(onClick = onDismissAll) {
                            Text(
                                text = Txt(MessageKey.business_notification_sound_dismiss_all),
                                color = MaterialTheme.colorScheme.onPrimaryContainer
                            )
                        }
                    }
                }

                alerts.forEach { alert ->
                    AlertItem(alert = alert, onOrderClick = onOrderClick)
                }
            }
        }
    }
}

@Composable
private fun AlertItem(alert: ActiveSoundAlert, onOrderClick: (String) -> Unit) {
    Card(
        onClick = {
            BusinessOrderNotificationStore.dismissAlert(alert.orderId)
            onOrderClick(alert.orderId)
        },
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primary.copy(alpha = ALERT_ITEM_ALPHA)
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x2),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = Txt(
                    MessageKey.business_notification_sound_new_order,
                    mapOf("code" to alert.shortCode)
                ),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onPrimaryContainer
            )
            TextButton(onClick = {
                BusinessOrderNotificationStore.dismissAlert(alert.orderId)
            }) {
                Text(
                    text = Txt(MessageKey.business_notification_sound_dismiss),
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
            }
        }
    }
}

@Composable
private fun MuteButton(config: OrderSoundConfig) {
    TextButton(onClick = { BusinessOrderNotificationStore.toggleMute() }) {
        Text(
            text = if (config.isMuted)
                Txt(MessageKey.business_notification_sound_unmute_action)
            else
                Txt(MessageKey.business_notification_sound_mute_action),
            color = MaterialTheme.colorScheme.onPrimaryContainer
        )
    }
}

private const val MILLIS_PER_SECOND = 1000L
private const val ALERT_ITEM_ALPHA = 0.15f
