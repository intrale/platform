package ui.cp.buttons

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector

@Composable
fun IntraleGhostButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    iconAsset: String? = null,
    leadingIcon: ImageVector? = null,
    leadingPainter: Painter? = null,
    enabled: Boolean = true,
    loading: Boolean = false,
    iconContentDescription: String? = null
) {
    val logger = IntraleButtonDefaults.rememberLogger("IntraleGhostButton")
    val isInteractive = IntraleButtonDefaults.isInteractive(enabled, loading)

    Surface(
        onClick = {
            logger.info { "IntraleGhostButton tap: $text" }
            onClick()
        },
        modifier = IntraleButtonDefaults.baseModifier(modifier, isInteractive),
        enabled = isInteractive,
        shape = MaterialTheme.shapes.large,
        color = Color.Transparent,
        contentColor = IntraleButtonDefaults.ghostContentColor()
    ) {
        IntraleButtonLayout(modifier = Modifier.fillMaxSize()) {
            IntraleButtonContent(
                text = text,
                iconAssetName = iconAsset,
                leadingIcon = leadingIcon,
                leadingPainter = leadingPainter,
                iconContentDescription = iconContentDescription,
                loading = loading,
                textColor = IntraleButtonDefaults.ghostContentColor(),
                progressColor = IntraleButtonDefaults.ghostContentColor(),
                iconTint = IntraleButtonDefaults.ghostContentColor()
            )
        }
    }
}
