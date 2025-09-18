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
import androidx.compose.runtime.LaunchedEffect
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
import kotlinx.coroutines.delay
import ui.accessibility.rememberMotionPreferences
import ui.th.rememberIntralePrimaryGradient
import ui.th.spacing

@Composable
fun IntralePrimaryButton(
    text: String,
    iconAsset: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    iconContentDescription: String? = null,
    stressTestState: IntraleButtonStressTestState = IntraleButtonStressTestState.Disabled
) {
    val logger = IntraleButtonDefaults.rememberLogger("IntralePrimaryButton")
    val isInteractive = IntraleButtonDefaults.isInteractive(enabled, loading)
    val motionPreferences = rememberMotionPreferences()

    var pressed by remember { mutableStateOf(false) }
    val scale = if (motionPreferences.reduceMotion || !isInteractive) {
        1f
    } else {
        val targetScale = if (pressed) 0.98f else 1f
        animateFloatAsState(
            targetValue = targetScale,
            animationSpec = tween(durationMillis = 120),
            label = "intralePrimaryButtonScale"
        ).value
    }

    val shimmerEnabled = isInteractive && !motionPreferences.reduceMotion
    val shimmerOffset: Float = if (shimmerEnabled) {
        val shimmerTransition = rememberInfiniteTransition(label = "intralePrimaryButtonShimmer")
        val offset by shimmerTransition.animateFloat(
            initialValue = -300f,
            targetValue = 300f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 1600, easing = LinearEasing)
            ),
            label = "intralePrimaryButtonShimmerOffset"
        )
        offset
    } else {
        0f
    }

    val gradientBrush = rememberIntralePrimaryGradient()
    val shimmerHighlight = MaterialTheme.colorScheme.onPrimary.copy(alpha = IntraleButtonDefaults.SHIMMER_HIGHLIGHT_ALPHA)

    var buttonModifier = IntraleButtonDefaults
        .baseModifier(modifier, isInteractive)
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
        }
        .clip(MaterialTheme.shapes.large)
        .background(gradientBrush)

    LaunchedEffect(stressTestState.active, stressTestState.tick, isInteractive) {
        if (stressTestState.active && isInteractive) {
            pressed = true
            logger.info { "IntralePrimaryButton stress tap: $text" }
            onClick()
            try {
                delay(IntraleButtonDefaults.STRESS_PRESS_DURATION_MILLIS)
            } finally {
                pressed = false
            }
        }
    }

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
        if (shimmerEnabled) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                drawRect(
                    brush = Brush.linearGradient(
                        colors = listOf(
                            Color.Transparent,
                            shimmerHighlight,
                            Color.Transparent
                        ),
                        start = Offset(shimmerOffset, 0f),
                        end = Offset(shimmerOffset + size.width / 3f, size.height)
                    ),
                    blendMode = BlendMode.SrcOver
                )
            }
        }
        IntraleButtonContent(
            text = text,
            iconAsset = iconAsset,
            iconContentDescription = iconContentDescription,
            loading = loading,
            textColor = MaterialTheme.colorScheme.onPrimary,
            progressColor = MaterialTheme.colorScheme.onPrimary,
            iconTint = MaterialTheme.colorScheme.onPrimary
        )
    }
}
