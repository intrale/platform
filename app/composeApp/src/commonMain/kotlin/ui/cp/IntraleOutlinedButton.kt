package ui.cp

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import ui.th.spacing

@Composable
fun IntraleOutlinedButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leadingIcon: ImageVector? = null,
    leadingPainter: Painter? = null,
    enabled: Boolean = true,
    loading: Boolean = false,
    iconContentDescription: String? = null
) {
    val logger = IntraleButtonDefaults.rememberLogger("IntraleOutlinedButton")
    val isInteractive = IntraleButtonDefaults.isInteractive(enabled, loading)

    Surface(
        onClick = {
            logger.info { "IntraleOutlinedButton tap: $text" }
            onClick()
        },
        modifier = IntraleButtonDefaults.baseModifier(modifier, isInteractive),
        enabled = isInteractive,
        shape = MaterialTheme.shapes.large,
        color = Color.Transparent,
        contentColor = IntraleButtonDefaults.outlinedContentColor(),
        border = BorderStroke(MaterialTheme.spacing.x0_5 / 2, IntraleButtonDefaults.outlinedBrush())
    ) {
        IntraleButtonLayout(modifier = Modifier.fillMaxSize()) {
            IntraleButtonContent(
                text = text,
                leadingIcon = leadingIcon,
                leadingPainter = leadingPainter,
                iconContentDescription = iconContentDescription,
                loading = loading,
                textColor = IntraleButtonDefaults.outlinedContentColor(),
                progressColor = IntraleButtonDefaults.outlinedContentColor(),
                iconTint = IntraleButtonDefaults.outlinedContentColor()
            )
        }
    }
}
