package ui.sc.client

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.ui.unit.dp
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ui.cp.buttons.IntralePrimaryButton
import ui.th.spacing

/**
 * Banner sticky de verificación de zona — issue #2422.
 *
 * Muestra tres variantes según el estado de [AddressCheckStore]:
 * - Pending: invita al usuario a verificar (CTA primario).
 * - Verified: chip discreto "Dirección verificada".
 * - OutOfZone: tono `errorContainer` con CTA "Probar otra dirección".
 *
 * Aparece como primer item del catálogo. Reutilizable para otras
 * pantallas que necesiten avisar al usuario de la zona.
 */
@Composable
fun AddressCheckBanner(
    phase: AddressCheckStore.Phase,
    onVerifyClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val pendingLabel = Txt(MessageKey.address_check_banner_pending_label)
    val pendingAction = Txt(MessageKey.address_check_banner_pending_action)
    val verifiedLabel = Txt(MessageKey.address_check_banner_verified_label)
    val outOfZoneLabel = Txt(MessageKey.address_check_banner_out_of_zone_label)
    val outOfZoneAction = Txt(MessageKey.address_check_banner_out_of_zone_action)
    val a11yPending = Txt(MessageKey.address_check_a11y_banner_pending)
    val a11yVerified = Txt(MessageKey.address_check_a11y_banner_verified)

    when (phase) {
        AddressCheckStore.Phase.Pending -> Card(
            modifier = modifier
                .fillMaxWidth()
                .semantics { contentDescription = a11yPending },
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            ),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x3),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
            ) {
                Icon(
                    imageVector = Icons.Default.LocationOn,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                )
                Text(
                    text = pendingLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                )
                IntralePrimaryButton(
                    text = pendingAction,
                    onClick = onVerifyClick,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                )
            }
        }

        AddressCheckStore.Phase.Verified -> Row(
            modifier = modifier
                .fillMaxWidth()
                .clickable(onClick = onVerifyClick)
                .padding(MaterialTheme.spacing.x2)
                .semantics { contentDescription = a11yVerified },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
        ) {
            Icon(
                imageVector = Icons.Default.CheckCircle,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = verifiedLabel,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.primary,
            )
        }

        AddressCheckStore.Phase.OutOfZone -> Card(
            modifier = modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.errorContainer,
            ),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x3),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
            ) {
                Icon(
                    imageVector = Icons.Default.Info,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                )
                Text(
                    text = outOfZoneLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = onVerifyClick,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(outOfZoneAction)
                }
            }
        }
    }
}

/**
 * Diálogo de bloqueo del carrito cuando el usuario intenta agregar un
 * producto sin haber verificado la zona (CA-1).
 */
@Composable
fun CartBlockedDialog(
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val title = Txt(MessageKey.address_check_cart_blocked_title)
    val message = Txt(MessageKey.address_check_cart_blocked_message)
    val confirmLabel = Txt(MessageKey.address_check_cart_blocked_action)
    val dismissLabel = Txt(MessageKey.address_check_cart_blocked_dismiss)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, fontWeight = FontWeight.SemiBold) },
        text = { Text(message) },
        confirmButton = {
            TextButton(onClick = onConfirm) { Text(confirmLabel) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(dismissLabel) }
        },
    )
}
