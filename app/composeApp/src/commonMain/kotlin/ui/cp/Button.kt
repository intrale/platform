package ui.cp

import androidx.compose.material3.Text
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ButtonColors
import androidx.compose.runtime.Composable
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

@Composable
fun Button(
    label: String,
    onClick: () -> Unit = {},
    loading: Boolean = false,
    enabled: Boolean = true,
    colors: ButtonColors = ButtonDefaults.buttonColors()
) {
    val logger = LoggerFactory.default.newLogger("ui.cp", "Button")

    androidx.compose.material3.Button(
        onClick = {
            logger.info { "Click en botón: $label" }
            onClick()
        },
        enabled = enabled && !loading,
        colors = colors
    ) {
        if (loading) {
            logger.info { "Mostrando indicador de progreso" }
            CircularProgressIndicator()
        } else {
            Text(label)
        }
    }
}