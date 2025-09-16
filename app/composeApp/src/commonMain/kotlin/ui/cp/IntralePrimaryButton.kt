package ui.cp

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

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
    val logger = remember { LoggerFactory.default.newLogger("ui.cp", "IntralePrimaryButton") }
    val isInteractive = enabled && !loading

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

    var buttonModifier = modifier
        .fillMaxWidth(0.9f)
        .height(54.dp)
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
        }
        .clip(RoundedCornerShape(18.dp))
        .background(
            brush = Brush.horizontalGradient(
                colors = listOf(Color(0xFF0A3D91), Color(0xFF1FB6FF))
            )
        )
        .alpha(if (isInteractive) 1f else 0.6f)

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

    Box(
        modifier = buttonModifier,
        contentAlignment = Alignment.Center
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            drawRect(
                brush = Brush.linearGradient(
                    colors = listOf(
                        Color.White.copy(alpha = 0f),
                        Color.White.copy(alpha = 0.25f),
                        Color.White.copy(alpha = 0f)
                    ),
                    start = Offset(shimmerOffset, 0f),
                    end = Offset(shimmerOffset + size.width / 3f, size.height)
                ),
                blendMode = BlendMode.Lighten
            )
        }
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
                    color = Color.White,
                    modifier = Modifier.size(22.dp)
                )
            } else {
                IntraleIcon(
                    assetName = iconAsset,
                    contentDesc = iconContentDescription ?: text,
                    modifier = Modifier.size(22.dp)
                )
            }
            Spacer(modifier = Modifier.width(12.dp))
            Text(
                text = text,
                color = Color.White,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                style = MaterialTheme.typography.titleMedium
            )
        }
    }
}
