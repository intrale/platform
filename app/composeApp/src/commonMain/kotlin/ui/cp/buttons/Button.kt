package ui.cp.buttons

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.th.spacing

@Composable
fun Button(
    label: String,
    onClick: () -> Unit = {},
    loading: Boolean = false,
    enabled: Boolean = true,
    colors: androidx.compose.material3.ButtonColors = IntraleButtonDefaults.primaryButtonColors()
) {
    val logger = LoggerFactory.default.newLogger("ui.cp.buttons", "Button")

    androidx.compose.material3.Button(
        onClick = {
            logger.info { "Click en botón: $label" }
            onClick()
        },
        enabled = enabled && !loading,
        colors = colors,
        shape = MaterialTheme.shapes.large,
        contentPadding = PaddingValues(
            horizontal = MaterialTheme.spacing.x2,
            vertical = MaterialTheme.spacing.x1_5
        )
    ) {
        if (loading) {
            logger.info { "Mostrando indicador de progreso" }
            CircularProgressIndicator(
                strokeWidth = MaterialTheme.spacing.x0_5 / 2,
                modifier = Modifier.size(MaterialTheme.spacing.x3),
                color = MaterialTheme.colorScheme.onPrimary
            )
        } else {
            Text(
                text = label,
                style = MaterialTheme.typography.labelLarge
            )
        }
    }
}
