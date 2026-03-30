package ext.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import asdo.client.IncomingPushNotification
import asdo.client.NotificationEventType
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Implementacion Android para mostrar notificaciones del sistema.
 * Usa NotificationManager y canales de notificacion (Android 8+).
 */
class AndroidPushNotificationDisplay(
    private val context: Context
) : PushNotificationDisplay {

    private val logger = LoggerFactory.default.newLogger<AndroidPushNotificationDisplay>()

    companion object {
        const val CHANNEL_ID_ORDERS = "intrale_order_updates"
        const val CHANNEL_NAME_ORDERS = "Estado de pedidos"
        const val CHANNEL_DESC_ORDERS = "Notificaciones sobre cambios en el estado de tus pedidos"

        const val CHANNEL_ID_MESSAGES = "intrale_messages"
        const val CHANNEL_NAME_MESSAGES = "Mensajes"
        const val CHANNEL_DESC_MESSAGES = "Mensajes de negocios"

        private const val ORDER_NOTIFICATION_BASE_ID = 2000
    }

    override fun initializeChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            val ordersChannel = NotificationChannel(
                CHANNEL_ID_ORDERS,
                CHANNEL_NAME_ORDERS,
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = CHANNEL_DESC_ORDERS
                enableVibration(true)
            }

            val messagesChannel = NotificationChannel(
                CHANNEL_ID_MESSAGES,
                CHANNEL_NAME_MESSAGES,
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = CHANNEL_DESC_MESSAGES
            }

            notificationManager.createNotificationChannels(listOf(ordersChannel, messagesChannel))
            logger.info { "Canales de notificacion creados" }
        }
    }

    override fun show(notification: IncomingPushNotification): Boolean {
        return try {
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            val channelId = when (notification.eventType) {
                NotificationEventType.BUSINESS_MESSAGE -> CHANNEL_ID_MESSAGES
                else -> CHANNEL_ID_ORDERS
            }

            val title = buildTitle(notification)
            val body = buildBody(notification)

            // Intent para abrir la app en el detalle del pedido
            val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("orderId", notification.orderId)
                putExtra("fromPush", true)
            }

            val pendingIntent = intent?.let {
                PendingIntent.getActivity(
                    context,
                    notification.orderId.hashCode(),
                    it,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            }

            val builder = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)

            pendingIntent?.let { builder.setContentIntent(it) }

            val notifId = ORDER_NOTIFICATION_BASE_ID + notification.orderId.hashCode()
            notificationManager.notify(notifId, builder.build())

            logger.info { "Notificacion del sistema mostrada: $title" }
            true
        } catch (e: Exception) {
            logger.error(e) { "Error al mostrar notificacion del sistema" }
            false
        }
    }

    private fun buildTitle(notification: IncomingPushNotification): String {
        return notification.businessName
    }

    private fun buildBody(notification: IncomingPushNotification): String {
        val prefix = "#${notification.shortCode}"
        return when (notification.eventType) {
            NotificationEventType.ORDER_CONFIRMED -> "$prefix - Pedido confirmado"
            NotificationEventType.ORDER_PREPARING -> "$prefix - Preparando tu pedido"
            NotificationEventType.ORDER_READY -> "$prefix - Pedido listo"
            NotificationEventType.ORDER_DELIVERING -> "$prefix - Pedido en camino"
            NotificationEventType.ORDER_DELIVERED -> "$prefix - Pedido entregado"
            NotificationEventType.ORDER_CANCELLED -> "$prefix - Pedido cancelado"
            NotificationEventType.ORDER_CREATED -> "$prefix - Pedido recibido"
            NotificationEventType.BUSINESS_MESSAGE ->
                if (notification.message.isNotBlank()) notification.message else "$prefix - Nuevo mensaje"
        }
    }
}
