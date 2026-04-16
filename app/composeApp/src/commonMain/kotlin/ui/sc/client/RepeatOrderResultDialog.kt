package ui.sc.client

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ar.com.intrale.shared.client.SkipReason
import asdo.client.ClientOrderItem
import asdo.client.PriceChange
import asdo.client.RepeatOrderResult
import asdo.client.SkippedItem
import ui.th.spacing
import ui.util.formatPrice

/**
 * Diálogo informativo que muestra el resultado de repetir un pedido
 * cuando hay cambios de precio y/o items no disponibles.
 *
 * Cumple criterios de aceptación de #2062:
 * - CA-2: Lista de productos agregados con nombre y cantidad.
 * - CA-3: Lista de productos excluidos con motivo individual (SkipReason).
 * - CA-4: Fallback "No disponible" si el motivo es desconocido.
 * - CA-7: Botón "Ir al carrito" sólo si hay items agregados.
 * - CA-9: Accesibilidad — contentDescription por item.
 * - CA-10: Nombres largos truncados con ellipsis.
 * - CA-11: Contador "(N)" sólo cuando hay más de 1 item.
 *
 * Extraído de ClientOrderDetailScreen para facilitar previews y showcase
 * dedicado (ver RepeatOrderDialogShowcaseScreen) que habilita a QA a
 * capturar video del diálogo en sus tres estados sin depender del backend.
 */
@Composable
fun RepeatOrderResultDialog(
    result: RepeatOrderResult,
    title: String,
    priceChangedLabel: String,
    priceBeforeLabel: String,
    priceNowLabel: String,
    itemsUnavailableLabel: String,
    addedLabel: String,
    viewCartLabel: String,
    closeLabel: String,
    reasonOutOfStock: String,
    reasonDiscontinued: String,
    reasonUnavailable: String,
    reasonUnknown: String,
    onViewCart: () -> Unit,
    onDismiss: () -> Unit
) {
    val hasAdded = result.addedItems.isNotEmpty()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 400.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                // Sección: items agregados (CA-2)
                if (hasAdded) {
                    AddedItemsSection(
                        items = result.addedItems,
                        sectionLabel = addedLabel
                    )
                }

                // Sección: cambios de precio
                if (result.priceChangedItems.isNotEmpty()) {
                    HorizontalDivider()
                    Text(
                        text = priceChangedLabel,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    result.priceChangedItems.forEach { priceChange ->
                        PriceChangeRow(
                            priceChange = priceChange,
                            beforeLabel = priceBeforeLabel,
                            nowLabel = priceNowLabel
                        )
                    }
                }

                // Sección: items no disponibles (CA-3, CA-4)
                if (result.skippedItems.isNotEmpty()) {
                    HorizontalDivider()
                    ExcludedItemsSection(
                        items = result.skippedItems,
                        sectionLabel = itemsUnavailableLabel,
                        reasonOutOfStock = reasonOutOfStock,
                        reasonDiscontinued = reasonDiscontinued,
                        reasonUnavailable = reasonUnavailable,
                        reasonUnknown = reasonUnknown
                    )
                }
            }
        },
        confirmButton = {
            // CA-7: botón "Ir al carrito" sólo si hay items agregados
            if (hasAdded) {
                Button(onClick = onViewCart) {
                    Text(viewCartLabel)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(closeLabel)
            }
        }
    )
}

/**
 * Sección "Agregados al carrito" con lista de productos (nombre + cantidad).
 */
@Composable
private fun AddedItemsSection(
    items: List<ClientOrderItem>,
    sectionLabel: String
) {
    // CA-11: contador sólo cuando hay más de 1 item
    val sectionTitle = if (items.size > 1) "$sectionLabel (${items.size})" else sectionLabel
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Icon(
            imageVector = Icons.Filled.CheckCircle,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.height(20.dp)
        )
        Text(
            text = sectionTitle,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary
        )
    }
    items.forEach { item ->
        // CA-9: accesibilidad con contentDescription
        val description = "${item.name} x${item.quantity}"
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = MaterialTheme.spacing.x4)
                .semantics { contentDescription = description },
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = item.name,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2, // CA-10: nombres largos
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(end = MaterialTheme.spacing.x2)
            )
            Text(
                text = "x${item.quantity}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/**
 * Sección "No disponibles" con lista de productos excluidos y motivo (SkipReason).
 */
@Composable
private fun ExcludedItemsSection(
    items: List<SkippedItem>,
    sectionLabel: String,
    reasonOutOfStock: String,
    reasonDiscontinued: String,
    reasonUnavailable: String,
    reasonUnknown: String
) {
    // CA-11: contador sólo cuando hay más de 1 item
    val sectionTitle = if (items.size > 1) "$sectionLabel (${items.size})" else sectionLabel
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Icon(
            imageVector = Icons.Filled.Warning,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.error,
            modifier = Modifier.height(20.dp)
        )
        Text(
            text = sectionTitle,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.error
        )
    }
    items.forEach { skipped ->
        val reasonText = when (skipped.reason) {
            SkipReason.OUT_OF_STOCK -> reasonOutOfStock
            SkipReason.DISCONTINUED -> reasonDiscontinued
            SkipReason.UNAVAILABLE -> reasonUnavailable
            SkipReason.UNKNOWN_PRODUCT -> reasonUnknown
        }.ifBlank { reasonUnavailable } // CA-4: fallback si motivo vacío
        val description = "${skipped.item.name} x${skipped.item.quantity} - $reasonText"
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = MaterialTheme.spacing.x4)
                .semantics { contentDescription = description }
        ) {
            Text(
                text = skipped.item.name,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2, // CA-10: nombres largos
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = reasonText,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/**
 * Fila individual de un producto con cambio de precio.
 */
@Composable
private fun PriceChangeRow(
    priceChange: PriceChange,
    beforeLabel: String,
    nowLabel: String
) {
    val isIncrease = priceChange.difference > 0
    val changeColor = if (isIncrease) {
        MaterialTheme.colorScheme.error
    } else {
        MaterialTheme.colorScheme.tertiary
    }
    val changePrefix = if (isIncrease) "+" else ""

    Surface(
        modifier = Modifier.fillMaxWidth(),
        tonalElevation = 1.dp,
        shape = MaterialTheme.shapes.small
    ) {
        Column(
            modifier = Modifier.padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            Text(
                text = priceChange.item.name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        text = "$beforeLabel: ${formatPrice(priceChange.item.unitPrice)}",
                        style = MaterialTheme.typography.bodySmall,
                        textDecoration = TextDecoration.LineThrough,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = "$nowLabel: ${formatPrice(priceChange.currentPrice)}",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold
                    )
                }
                Text(
                    text = "$changePrefix${formatPrice(priceChange.difference)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = changeColor,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}
