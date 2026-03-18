package ui.cp.loading

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import ui.th.spacing

/**
 * Bloque rectangular con efecto shimmer para representar contenido cargando.
 */
@Composable
fun SkeletonBox(
    modifier: Modifier = Modifier,
    width: Dp = Dp.Unspecified,
    height: Dp = 16.dp
) {
    val infiniteTransition = rememberInfiniteTransition(label = "skeleton")
    val alpha by infiniteTransition.animateFloat(
        initialValue = 0.15f,
        targetValue = 0.35f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 800, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "skeleton-alpha"
    )

    val baseModifier = modifier
        .height(height)
        .clip(RoundedCornerShape(4.dp))
        .background(Color.Gray.copy(alpha = alpha))

    if (width != Dp.Unspecified) {
        Box(modifier = baseModifier.width(width))
    } else {
        Box(modifier = baseModifier.fillMaxWidth())
    }
}

/**
 * Card skeleton que simula la forma de un [DashboardActionCard] mientras se cargan los datos.
 */
@Composable
fun DashboardCardSkeleton(modifier: Modifier = Modifier) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x2),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            // Titulo
            SkeletonBox(width = 120.dp, height = 20.dp)
            // Descripcion
            SkeletonBox(height = 14.dp)
            SkeletonBox(width = 200.dp, height = 14.dp)
            // Metrica
            SkeletonBox(width = 100.dp, height = 12.dp)
            // Botones
            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x0_5))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End
            ) {
                SkeletonBox(width = 80.dp, height = 32.dp)
                Spacer(modifier = Modifier.width(MaterialTheme.spacing.x1))
                SkeletonBox(width = 80.dp, height = 32.dp)
            }
        }
    }
    Spacer(modifier = Modifier.height(4.dp))
}

/**
 * Conjunto de skeletons que simula el dashboard completo mientras carga.
 */
@Composable
fun DashboardSkeletonContent(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
    ) {
        // Header skeleton
        SkeletonBox(width = 180.dp, height = 28.dp)
        SkeletonBox(width = 140.dp, height = 18.dp)
        SkeletonBox(height = 14.dp)

        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x1))

        // Cards skeleton (simulando 4 cards)
        repeat(4) {
            DashboardCardSkeleton()
        }
    }
}
