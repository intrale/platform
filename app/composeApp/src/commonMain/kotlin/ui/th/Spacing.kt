package ui.th

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

@Stable
data class IntraleSpacing(
    val none: Dp = 0.dp,
    val x0_5: Dp = 4.dp,
    val x1: Dp = 8.dp,
    val x1_5: Dp = 12.dp,
    val x2: Dp = 16.dp,
    val x2_5: Dp = 20.dp,
    val x3: Dp = 24.dp,
    val x4: Dp = 32.dp,
    val x5: Dp = 40.dp,
    val x6: Dp = 48.dp,
    val x7: Dp = 56.dp,
    val x8: Dp = 64.dp
)

val LocalSpacing = staticCompositionLocalOf { IntraleSpacing() }

val MaterialTheme.spacing: IntraleSpacing
    @Composable
    @ReadOnlyComposable
    get() = LocalSpacing.current
