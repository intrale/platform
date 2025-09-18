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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.kodein.log.Logger
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

internal object IntraleButtonDefaults {
    const val WIDTH_FRACTION = 0.9f
    val HEIGHT = 54.dp
    val SHAPE = RoundedCornerShape(18.dp)
    private const val DISABLED_ALPHA = 0.6f
    const val SHIMMER_HIGHLIGHT_ALPHA = 0.12f
    const val STRESS_TAP_PERIOD_MILLIS = 160L
    const val STRESS_PRESS_DURATION_MILLIS = 90L

    fun isInteractive(enabled: Boolean, loading: Boolean): Boolean = enabled && !loading

    fun baseModifier(modifier: Modifier, isInteractive: Boolean): Modifier = modifier
        .fillMaxWidth(WIDTH_FRACTION)
        .height(HEIGHT)
        .alpha(if (isInteractive) 1f else DISABLED_ALPHA)

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
    iconAsset: String,
    iconContentDescription: String?,
    loading: Boolean,
    textColor: Color,
    progressColor: Color,
    iconTint: Color?
) {
    Row(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (loading) {
            CircularProgressIndicator(
                strokeWidth = 2.dp,
                color = progressColor,
                modifier = Modifier.size(22.dp)
            )
        } else {
            IntraleIcon(
                assetName = iconAsset,
                contentDesc = iconContentDescription ?: text,
                modifier = Modifier.size(22.dp),
                tint = iconTint
            )
        }
        Spacer(modifier = Modifier.width(12.dp))
        Text(
            text = text,
            color = textColor,
            style = MaterialTheme.typography.titleMedium.copy(
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp
            )
        )
    }
}

@Immutable
data class IntraleButtonStressTestState(
    val active: Boolean = false,
    val tick: Int = 0
) {
    companion object {
        val Disabled = IntraleButtonStressTestState(false, 0)
    }
}
