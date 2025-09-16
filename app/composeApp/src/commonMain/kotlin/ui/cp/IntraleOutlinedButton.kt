package ui.cp

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

@Composable
fun IntraleOutlinedButton(
    text: String,
    iconAsset: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    iconContentDescription: String? = null
) {
    val logger = IntraleButtonDefaults.rememberLogger("IntraleOutlinedButton")
    val isInteractive = IntraleButtonDefaults.isInteractive(enabled, loading)

    val borderBrush = remember {
        Brush.horizontalGradient(
            colors = listOf(Color(0xFF0A3D91), Color(0xFF1FB6FF))
        )
    }

    Surface(
        onClick = {
            logger.info { "IntraleOutlinedButton tap: $text" }
            onClick()
        },
        modifier = IntraleButtonDefaults.baseModifier(modifier, isInteractive),
        enabled = isInteractive,
        shape = IntraleButtonDefaults.SHAPE,
        color = Color.Transparent,
        contentColor = MaterialTheme.colorScheme.primary,
        border = BorderStroke(2.dp, borderBrush)
    ) {
        IntraleButtonLayout(modifier = Modifier.fillMaxSize()) {
            IntraleButtonContent(
                text = text,
                iconAsset = iconAsset,
                iconContentDescription = iconContentDescription,
                loading = loading,
                textColor = MaterialTheme.colorScheme.primary,
                progressColor = MaterialTheme.colorScheme.primary,
                iconTint = MaterialTheme.colorScheme.primary
            )
        }
    }
}
