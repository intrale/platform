package ui.cp.delivery

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.client.ClientOrderStatus
import asdo.client.DeliveryTimeEstimation
import ui.th.spacing

/**
 * Tarjeta visual que muestra la estimacion inteligente de tiempo de entrega.
 * Incluye:
 * - Texto con minutos estimados (p.ej. "~25 min")
 * - Rango minimo-maximo
 * - Barra de progreso del pedido
 * - Factores que influyen en la estimacion
 * - Aviso si el pedido se demora mas de lo previsto
 */
@Composable
fun DeliveryEstimationCard(
    modifier: Modifier = Modifier,
    estimation: DeliveryTimeEstimation? = null,
    isLoading: Boolean = false,
    errorMessage: String? = null,
    orderStatus: ClientOrderStatus? = null,
    isDelayed: Boolean = false,
    onRetry: (() -> Unit)? = null,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = Txt(MessageKey.delivery_estimation_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onPrimaryContainer
            )

            when {
                isLoading -> DeliveryEstimationLoading()
                errorMessage != null -> DeliveryEstimationError(
                    errorMessage = errorMessage,
                    onRetry = onRetry
                )
                estimation != null -> DeliveryEstimationContent(
                    estimation = estimation,
                    orderStatus = orderStatus,
                    isDelayed = isDelayed
                )
                else -> Text(
                    text = Txt(MessageKey.delivery_estimation_unavailable),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
            }
        }
    }
}

@Composable
private fun DeliveryEstimationLoading() {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
        verticalAlignment = Alignment.CenterVertically
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(20.dp),
            strokeWidth = 2.dp,
            color = MaterialTheme.colorScheme.onPrimaryContainer
        )
        Text(
            text = Txt(MessageKey.delivery_estimation_loading),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onPrimaryContainer
        )
    }
}

@Composable
private fun DeliveryEstimationError(
    errorMessage: String,
    onRetry: (() -> Unit)?
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Text(
            text = errorMessage,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error
        )
        if (onRetry != null) {
            TextButton(onClick = onRetry) {
                Text(text = Txt(MessageKey.delivery_estimation_retry))
            }
        }
    }
}

@Composable
private fun DeliveryEstimationContent(
    estimation: DeliveryTimeEstimation,
    orderStatus: ClientOrderStatus?,
    isDelayed: Boolean,
) {
    // Minutos estimados (grande + destacado)
    val minutesText = if (estimation.displayText.isNotBlank()) {
        estimation.displayText
    } else {
        Txt(
            key = MessageKey.delivery_estimation_minutes,
            params = mapOf("minutes" to estimation.estimatedMinutes.toString())
        )
    }
    Text(
        text = minutesText,
        style = MaterialTheme.typography.headlineMedium,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.onPrimaryContainer
    )

    // Rango de confianza
    if (estimation.minMinutes > 0 && estimation.maxMinutes >= estimation.minMinutes) {
        Text(
            text = Txt(
                key = MessageKey.delivery_estimation_minutes_range,
                params = mapOf(
                    "min" to estimation.minMinutes.toString(),
                    "max" to estimation.maxMinutes.toString()
                )
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onPrimaryContainer
        )
    }

    // Barra de progreso del pedido segun estado
    orderStatus?.let { status ->
        DeliveryProgressBar(status = status)
    }

    // Aviso de demora
    if (isDelayed) {
        Text(
            text = Txt(MessageKey.delivery_estimation_delayed_notice),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            fontWeight = FontWeight.SemiBold
        )
    }

    // Factores contextuales (si hay datos significativos)
    DeliveryEstimationFactorsRow(estimation = estimation)
}

/**
 * Barra de progreso visual del pedido con labels del estado actual.
 */
@Composable
private fun DeliveryProgressBar(status: ClientOrderStatus) {
    val progress = status.toProgressFraction()
    val animatedProgress by animateFloatAsState(
        targetValue = progress,
        animationSpec = tween(durationMillis = 450),
        label = "delivery-estimation-progress"
    )
    Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)) {
        LinearProgressIndicator(
            progress = { animatedProgress },
            modifier = Modifier
                .fillMaxWidth()
                .height(8.dp),
            color = MaterialTheme.colorScheme.primary,
            trackColor = MaterialTheme.colorScheme.surfaceVariant,
            strokeCap = androidx.compose.ui.graphics.StrokeCap.Round
        )
        Text(
            text = Txt(status.toProgressLabelKey()),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onPrimaryContainer
        )
    }
}

@Composable
private fun DeliveryEstimationFactorsRow(estimation: DeliveryTimeEstimation) {
    val factors = estimation.factors
    val isPeakHour = factors.hourOfDay in 12..14 || factors.hourOfDay in 20..22

    val rows = buildList {
        if (factors.activeOrders > 0) {
            add(
                Txt(
                    key = MessageKey.delivery_estimation_factor_active_orders,
                    params = mapOf("count" to factors.activeOrders.toString())
                )
            )
        }
        factors.distanceKm?.let { km ->
            add(
                Txt(
                    key = MessageKey.delivery_estimation_factor_distance,
                    params = mapOf("km" to formatDistance(km))
                )
            )
        }
        if (isPeakHour) {
            add(Txt(MessageKey.delivery_estimation_factor_peak_hour))
        }
        factors.historicalAvgMinutes?.let { avg ->
            add(
                Txt(
                    key = MessageKey.delivery_estimation_factor_historical,
                    params = mapOf("minutes" to avg.toInt().toString())
                )
            )
        }
    }

    if (rows.isEmpty()) return

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = MaterialTheme.spacing.x1),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        rows.forEach { line ->
            Text(
                text = line,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.85f)
            )
        }
    }
}

/**
 * Progreso estimado del pedido segun su estado para la barra visual.
 * Incluye un colchon intermedio para evitar saltos abruptos.
 */
internal fun ClientOrderStatus.toProgressFraction(): Float = when (this) {
    ClientOrderStatus.PENDING -> 0.05f
    ClientOrderStatus.CONFIRMED -> 0.20f
    ClientOrderStatus.PREPARING -> 0.45f
    ClientOrderStatus.READY -> 0.65f
    ClientOrderStatus.DELIVERING -> 0.85f
    ClientOrderStatus.DELIVERED -> 1.0f
    ClientOrderStatus.CANCELLED -> 0.0f
    ClientOrderStatus.UNKNOWN -> 0.0f
}

private fun ClientOrderStatus.toProgressLabelKey(): MessageKey = when (this) {
    ClientOrderStatus.DELIVERING -> MessageKey.delivery_estimation_progress_on_the_way
    ClientOrderStatus.DELIVERED -> MessageKey.delivery_estimation_progress_delivered
    else -> MessageKey.delivery_estimation_progress_preparing
}

private fun formatDistance(km: Double): String {
    val rounded = (km * 10).toInt() / 10.0
    return rounded.toString()
}

// Evita warning de import no usado si en algun target no se resuelve Color; mantiene API
@Suppress("unused")
private val transparentColor: Color = Color.Transparent
