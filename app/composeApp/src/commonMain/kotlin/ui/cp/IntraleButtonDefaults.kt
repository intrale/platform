package ui.cp

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import org.kodein.log.Logger
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.th.spacing

internal object IntraleButtonDefaults {
    private const val DISABLED_ALPHA = 0.6f

    fun isInteractive(enabled: Boolean, loading: Boolean): Boolean = enabled && !loading

    @Composable
    fun baseModifier(modifier: Modifier, isInteractive: Boolean): Modifier = modifier
        .fillMaxWidth()
        .height(MaterialTheme.spacing.x7)
        .alpha(if (isInteractive) 1f else DISABLED_ALPHA)

    @Composable
    fun primaryBrush(): Brush {
        val colors = MaterialTheme.colorScheme
        return remember(colors.primary, colors.primaryContainer) {
            Brush.horizontalGradient(listOf(colors.primary, colors.primaryContainer))
        }
    }

    @Composable
    fun outlinedBrush(): Brush {
        val colors = MaterialTheme.colorScheme
        return remember(colors.primary, colors.tertiary) {
            Brush.horizontalGradient(listOf(colors.primary, colors.tertiary))
        }
    }

    @Composable
    fun primaryContentColor(): Color = MaterialTheme.colorScheme.onPrimary

    @Composable
    fun outlinedContentColor(): Color = MaterialTheme.colorScheme.primary

    @Composable
    fun ghostContentColor(): Color = MaterialTheme.colorScheme.primary

    @Composable
    fun primaryButtonColors(): ButtonColors = ButtonDefaults.buttonColors(
        containerColor = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
        disabledContainerColor = MaterialTheme.colorScheme.surfaceVariant,
        disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant
    )

    @Composable
    fun rememberLogger(componentName: String): Logger = remember {
        LoggerFactory.default.newLogger("ui.cp", componentName)
    }
}

@Composable
internal fun IntraleButtonLayout(
    modifier: Modifier,
    content: @Composable () -> Unit
) {
    androidx.compose.foundation.layout.Box(
        modifier = modifier,
        contentAlignment = Alignment.Center
    ) {
        content()
    }
}

@Composable
internal fun IntraleButtonContent(
    text: String,
    leadingIcon: ImageVector?,
    leadingPainter: Painter?,
    iconContentDescription: String?,
    loading: Boolean,
    textColor: Color,
    progressColor: Color,
    iconTint: Color?
) {
    Row(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x2),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (loading) {
            CircularProgressIndicator(
                strokeWidth = MaterialTheme.spacing.x0_5 / 2,
                color = progressColor,
                modifier = Modifier.size(MaterialTheme.spacing.x3)
            )

            Spacer(modifier = Modifier.width(MaterialTheme.spacing.x2))
            Text(
                text = text,
                color = textColor,
                style = MaterialTheme.typography.labelLarge
            )
        } else {
            when {
                leadingIcon != null -> {
                    Icon(
                        imageVector = leadingIcon,
                        contentDescription = iconContentDescription ?: text,
                        modifier = Modifier.size(MaterialTheme.spacing.x3),
                        tint = iconTint ?: textColor
                    )
                    Spacer(modifier = Modifier.width(MaterialTheme.spacing.x2))
                }

                leadingPainter != null -> {
                    Icon(
                        painter = leadingPainter,
                        contentDescription = iconContentDescription ?: text,
                        modifier = Modifier.size(MaterialTheme.spacing.x3),
                        tint = iconTint ?: textColor
                    )
                    Spacer(modifier = Modifier.width(MaterialTheme.spacing.x2))
                }
            }
            Text(
                text = text,
                color = textColor,
                style = MaterialTheme.typography.labelLarge
            )
        }
    }
}
