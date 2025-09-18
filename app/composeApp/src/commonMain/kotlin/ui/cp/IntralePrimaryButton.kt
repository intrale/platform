package ui.cp

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import ui.th.spacing

@Composable
fun IntralePrimaryButton(
    text: String,
    iconAsset: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    iconContentDescription: String? = null
) {
    val logger = IntraleButtonDefaults.rememberLogger("IntralePrimaryButton")
    val isInteractive = IntraleButtonDefaults.isInteractive(enabled, loading)

    var pressed by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        targetValue = if (pressed && isInteractive) 0.98f else 1f,
        animationSpec = tween(durationMillis = 120),
        label = "intralePrimaryButtonScale"
    )

    val shimmerTransition = rememberInfiniteTransition(label = "intralePrimaryButtonShimmer")
    val shimmerOffset by shimmerTransition.animateFloat(
        initialValue = -300f,
        targetValue = 300f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1600, easing = LinearEasing)
        ),
        label = "intralePrimaryButtonShimmerOffset"
    )

    val gradientBrush = IntraleButtonDefaults.primaryBrush()

    var buttonModifier = IntraleButtonDefaults
        .baseModifier(modifier, isInteractive)
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
        }
        .clip(MaterialTheme.shapes.large)
        .background(gradientBrush)

    if (isInteractive) {
        buttonModifier = buttonModifier.pointerInput(text, iconAsset) {
            detectTapGestures(
                onPress = {
                    pressed = true
                    try {
                        tryAwaitRelease()
                    } finally {
                        pressed = false
                    }
                },
                onTap = {
                    logger.info { "IntralePrimaryButton tap: $text" }
                    onClick()
                }
            )
        }
    }

    IntraleButtonLayout(modifier = buttonModifier) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            drawRect(
                brush = Brush.linearGradient(
                    colors = listOf(
                        MaterialTheme.colorScheme.onPrimary.copy(alpha = 0f),
                        MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.25f),
                        MaterialTheme.colorScheme.onPrimary.copy(alpha = 0f)
                    ),
                    start = Offset(shimmerOffset, 0f),
                    end = Offset(shimmerOffset + size.width / 3f, size.height)
                ),
                blendMode = BlendMode.Lighten
            )
        }
        IntraleButtonContent(
            text = text,
            iconAsset = iconAsset,
            iconContentDescription = iconContentDescription,
            loading = loading,
            textColor = IntraleButtonDefaults.primaryContentColor(),
            progressColor = IntraleButtonDefaults.primaryContentColor(),
            iconTint = IntraleButtonDefaults.primaryContentColor()
        )
    }
}
