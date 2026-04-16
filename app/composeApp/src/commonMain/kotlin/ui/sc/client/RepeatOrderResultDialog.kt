package ui.sc.client

import ar.com.intrale.shared.client.SkipReason
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import asdo.client.ClientOrderItem
import asdo.client.RepeatOrderResult
import asdo.client.SkippedItem
import ui.th.spacing

/**
 * Dialogo que muestra el resultado de repetir un pedido:
 * - Items agregados al carrito (caso parcial)
 * - Items excluidos con motivo (caso parcial o ninguno disponible)
 */
@Composable
fun RepeatOrderResultDialog(
    result: RepeatOrderResult,
    onDismiss: () -> Unit,
    onGoToCart: () -> Unit
) {
    val title = Txt(MessageKey.client_orders_repeat_result_title)
    val addedSectionLabel = Txt(MessageKey.client_orders_repeat_added_section)
    val excludedSectionLabel = Txt(MessageKey.client_orders_repeat_excluded_section)
    val goCartLabel = Txt(MessageKey.client_orders_repeat_go_cart)
    val closeLabel = Txt(MessageKey.client_orders_repeat_close)

    val hasAdded = result.addedItems.isNotEmpty()
    val hasSkipped = result.skippedItems.isNotEmpty()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(text = title) },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 400.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                if (hasAdded) {
                    AddedItemsSection(
                        items = result.addedItems,
                        sectionLabel = addedSectionLabel
                    )
                }
                if (hasAdded && hasSkipped) {
                    HorizontalDivider(modifier = Modifier.padding(vertical = MaterialTheme.spacing.x1))
                }
                if (hasSkipped) {
                    ExcludedItemsSection(
                        items = result.skippedItems,
                        sectionLabel = excludedSectionLabel
                    )
                }
            }
        },
        confirmButton = {
            if (hasAdded) {
                TextButton(onClick = onGoToCart) {
                    Text(text = goCartLabel)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(text = closeLabel)
            }
        }
    )
}

@Composable
private fun AddedItemsSection(
    items: List<ClientOrderItem>,
    sectionLabel: String
) {
    val sectionTitle = if (items.size > 1) "$sectionLabel (${items.size})" else sectionLabel
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Icon(
            imageVector = Icons.Filled.CheckCircle,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(20.dp)
        )
        Text(
            text = sectionTitle,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary
        )
    }
    items.forEach { item ->
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
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Text(
                text = "x${item.quantity}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = MaterialTheme.spacing.x2)
            )
        }
    }
}

@Composable
private fun ExcludedItemsSection(
    items: List<SkippedItem>,
    sectionLabel: String
) {
    val sectionTitle = if (items.size > 1) "$sectionLabel (${items.size})" else sectionLabel
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Icon(
            imageVector = Icons.Filled.Warning,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.error,
            modifier = Modifier.size(20.dp)
        )
        Text(
            text = sectionTitle,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.error
        )
    }
    items.forEach { skippedItem ->
        val reasonText = skipReasonText(skippedItem.reason)
        val description = "${skippedItem.item.name} x${skippedItem.item.quantity} - $reasonText"
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = MaterialTheme.spacing.x4)
                .semantics { contentDescription = description }
        ) {
            Text(
                text = skippedItem.item.name,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
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

@Composable
private fun skipReasonText(reason: SkipReason): String {
    return when (reason) {
        SkipReason.OUT_OF_STOCK -> Txt(MessageKey.client_orders_repeat_reason_out_of_stock)
        SkipReason.DISCONTINUED -> Txt(MessageKey.client_orders_repeat_reason_discontinued)
        SkipReason.UNAVAILABLE -> Txt(MessageKey.client_orders_repeat_reason_unavailable)
        SkipReason.UNKNOWN_PRODUCT -> Txt(MessageKey.client_orders_repeat_reason_unknown)
    }
}
