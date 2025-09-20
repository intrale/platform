package ui.cp.menu

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material.ripple.rememberRipple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp as lerpColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.consumePositionChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.lerp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import org.jetbrains.compose.ui.tooling.preview.Preview

/**
 * Representa una acción dentro del menú semicircular.
 */
data class MainMenuItem(
    val id: String,
    val label: String,
    val icon: ImageVector,
    val requiredRoles: Set<String> = emptySet(),
    val onClick: () -> Unit
)

/**
 * Estados disponibles para el menú semicircular.
 */
enum class MenuState {
    Collapsed,
    Expanding,
    Expanded,
    Collapsing
}

/**
 * Esquinas disponibles para anclar el menú semicircular.
 */
enum class Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/**
 * Muestra un menú en forma de semicírculo anclado a una esquina del contenedor.
 */
@Composable
fun SemiCircularHamburgerMenu(
    items: List<MainMenuItem>,
    collapsedContentDescription: String,
    expandedContentDescription: String,
    modifier: Modifier = Modifier,
    arcDegrees: Float = 140f,
    startAngleDegrees: Float = 20f,
    collapsedRadius: Dp = 64.dp,
    expandedRadius: Dp = 220.dp,
    anchorCorner: Corner = Corner.TopRight,
    windowInsets: WindowInsets = WindowInsets.statusBars,
    initiallyExpanded: Boolean = false,
    onStateChange: ((MenuState) -> Unit)? = null,
    onItemSelected: ((MainMenuItem) -> Unit)? = null,
) {
    val filteredItems = remember(items) { items.distinctBy(MainMenuItem::id) }
    val hapticFeedback = LocalHapticFeedback.current

    var expanded by rememberSaveable { mutableStateOf(initiallyExpanded) }
    var dragProgress by remember { mutableStateOf(if (initiallyExpanded) 1f else 0f) }
    var isDragging by remember { mutableStateOf(false) }
    var menuState by remember { mutableStateOf(if (initiallyExpanded) MenuState.Expanded else MenuState.Collapsed) }

    fun updateState(state: MenuState) {
        if (menuState != state) {
            menuState = state
            onStateChange?.invoke(state)
        }
    }

    fun collapseMenu() {
        expanded = false
        dragProgress = 0f
        isDragging = false
        updateState(MenuState.Collapsing)
    }

    fun expandMenu() {
        expanded = true
        dragProgress = 1f
        isDragging = false
        updateState(MenuState.Expanding)
    }

    val displayedProgress = if (isDragging) dragProgress else if (expanded) 1f else 0f

    val infiniteTransition = rememberInfiniteTransition(label = "semiCircularMenuGlow")
    val glowProgress by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1600, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "semiCircularMenuGlowProgress"
    )

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val density = LocalDensity.current
        val layoutDirection = LocalLayoutDirection.current
        val safePadding = windowInsets.asPaddingValues()
        val maxWidthPx = with(density) { maxWidth.toPx() }
        val maxHeightPx = with(density) { maxHeight.toPx() }
        val horizontalInsetsPx = with(density) {
            safePadding.calculateLeftPadding(layoutDirection).toPx() +
                safePadding.calculateRightPadding(layoutDirection).toPx()
        }
        val verticalInsetsPx = with(density) {
            safePadding.calculateTopPadding().toPx() +
                safePadding.calculateBottomPadding().toPx()
        }
        val safeMarginPx = with(density) { MenuOuterMargin.toPx() }
        val safeWidthPx = (maxWidthPx - horizontalInsetsPx - safeMarginPx).coerceAtLeast(0f)
        val safeHeightPx = (maxHeightPx - verticalInsetsPx - safeMarginPx).coerceAtLeast(0f)
        val collapsedRadiusPx = with(density) { collapsedRadius.toPx() }
        val configuredExpandedRadiusPx = with(density) { expandedRadius.toPx() }
        val computedExpandedRadiusPx = min(
            configuredExpandedRadiusPx,
            min(safeWidthPx, safeHeightPx * 0.48f)
        ).coerceAtLeast(collapsedRadiusPx)
        val effectiveExpandedRadius = with(density) { computedExpandedRadiusPx.toDp() }
        val effectiveArcDegrees = arcDegrees.coerceIn(120f, 170f)

        val targetRadius = lerp(
            start = collapsedRadius,
            stop = effectiveExpandedRadius,
            fraction = displayedProgress.coerceIn(0f, 1f)
        )

        val radius by animateDpAsState(
            targetValue = targetRadius,
            animationSpec = spring(
                dampingRatio = Spring.DampingRatioMediumBouncy,
                stiffness = Spring.StiffnessMediumLow
            ),
            label = "semiCircularMenuRadius"
        )

        val sweepAngle by animateFloatAsState(
            targetValue = effectiveArcDegrees * (0.25f + 0.75f * displayedProgress.coerceIn(0f, 1f)),
            animationSpec = tween(durationMillis = 240, easing = FastOutSlowInEasing),
            label = "semiCircularMenuSweep"
        )

        val toggleRotation by animateFloatAsState(
            targetValue = if (expanded) 0f else -90f,
            animationSpec = tween(durationMillis = 220, easing = FastOutSlowInEasing),
            label = "semiCircularMenuToggleRotation"
        )

        val dragRangePx = remember(collapsedRadius, effectiveExpandedRadius) {
            max(1f, with(density) { (effectiveExpandedRadius - collapsedRadius).coerceAtLeast(0.dp).toPx() })
        }

        LaunchedEffect(expanded, displayedProgress, isDragging) {
            if (!isDragging) {
                when {
                    expanded && displayedProgress >= 0.99f -> {
                        updateState(MenuState.Expanded)
                        hapticFeedback.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    }

                    !expanded && displayedProgress <= 0.01f -> {
                        updateState(MenuState.Collapsed)
                    }
                }
            }
        }

        Box(modifier = Modifier.fillMaxSize()) {
            if (displayedProgress > 0.05f) {
                Box(
                    modifier = Modifier
                        .matchParentSize()
                        .pointerInput(Unit) {
                            detectTapGestures { collapseMenu() }
                        }
                )
            }

            Box(
                modifier = modifier
                    .then(Modifier.size(radius * 2f))
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .semantics(mergeDescendants = true) {
                            contentDescription = if (expanded) expandedContentDescription else collapsedContentDescription
                            stateDescription = when (menuState) {
                                MenuState.Collapsed -> "Colapsado"
                                MenuState.Expanding -> "Expandiéndose"
                                MenuState.Expanded -> "Expandido"
                                MenuState.Collapsing -> "Colapsando"
                            }
                            role = Role.Button
                            onClick {
                                if (expanded) collapseMenu() else expandMenu()
                                true
                            }
                        }
                        .pointerInput(expanded) {
                            detectTapGestures {
                                if (expanded) collapseMenu() else expandMenu()
                            }
                        }
                        .pointerInput(dragRangePx, expanded) {
                            detectDragGestures(
                                onDragStart = {
                                    isDragging = true
                                    dragProgress = if (expanded) 1f else 0f
                                    updateState(if (expanded) MenuState.Collapsing else MenuState.Expanding)
                                },
                                onDragEnd = {
                                    isDragging = false
                                    val shouldExpand = dragProgress > 0.4f
                                    if (shouldExpand) {
                                        expanded = true
                                        dragProgress = 1f
                                        updateState(MenuState.Expanding)
                                    } else {
                                        expanded = false
                                        dragProgress = 0f
                                        updateState(MenuState.Collapsing)
                                    }
                                },
                                onDragCancel = {
                                    isDragging = false
                                    dragProgress = if (expanded) 1f else 0f
                                    updateState(if (expanded) MenuState.Expanded else MenuState.Collapsed)
                                }
                            ) { change, dragAmount ->
                                val weightedDelta =
                                    dragAmount.x * 0.7f * anchorCorner.horizontalDirection() +
                                        dragAmount.y * 0.3f * anchorCorner.verticalDirection()
                                dragProgress = (dragProgress + weightedDelta / dragRangePx).coerceIn(0f, 1f)
                                change.consumePositionChange()
                            }
                        }
                ) {
                    val tintedPrimary = lerpColor(
                        MaterialTheme.colorScheme.primary,
                        MaterialTheme.colorScheme.tertiary,
                        displayedProgress.coerceIn(0f, 1f)
                    )

                    Box(
                        modifier = Modifier
                            .matchParentSize()
                            .drawBehind {
                                val brush = Brush.sweepGradient(
                                    colorStops = arrayOf(
                                        0f to tintedPrimary.copy(alpha = 0.95f),
                                        0.4f to MaterialTheme.colorScheme.primaryContainer,
                                        0.7f to tintedPrimary.copy(alpha = 0.9f),
                                        1f to tintedPrimary.copy(alpha = 0.95f)
                                    ),
                                    center = Offset(size.width / 2f, size.height / 2f),
                                    rotation = glowProgress * 360f
                                )
                                drawSemiCircle(
                                    anchorCorner = anchorCorner,
                                    startAngle = startAngleDegrees,
                                    sweepAngle = sweepAngle.coerceIn(0f, effectiveArcDegrees),
                                    brush = brush
                                )
                            }
                    )

                    MenuToggleIcon(
                        expanded = expanded,
                        rotation = toggleRotation,
                        collapsedContentDescription = collapsedContentDescription,
                        expandedContentDescription = expandedContentDescription
                    )

                    RadialMenuItems(
                        items = filteredItems,
                        progress = displayedProgress,
                        radius = radius,
                        arcDegrees = effectiveArcDegrees,
                        startAngleDegrees = startAngleDegrees,
                        anchorCorner = anchorCorner
                    ) { item ->
                        collapseMenu()
                        onItemSelected?.invoke(item)
                        item.onClick()
                    }
                }
            }
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawSemiCircle(
    anchorCorner: Corner,
    startAngle: Float,
    sweepAngle: Float,
    brush: Brush,
) {
    val diameter = min(size.width, size.height)
    val (resolvedStart, resolvedSweep) = anchorCorner.orientArc(startAngle, sweepAngle)
    drawArc(
        brush = brush,
        startAngle = resolvedStart,
        sweepAngle = resolvedSweep,
        useCenter = true,
        size = Size(diameter, diameter),
        topLeft = Offset.Zero
    )
}

@Composable
private fun BoxScope.MenuToggleIcon(
    expanded: Boolean,
    rotation: Float,
    collapsedContentDescription: String,
    expandedContentDescription: String,
) {
    Surface(
        modifier = Modifier
            .align(Alignment.Center)
            .size(MenuToggleSize),
        shape = CircleShape,
        tonalElevation = 4.dp,
        color = MaterialTheme.colorScheme.primaryContainer
    ) {
        Icon(
            imageVector = if (expanded) Icons.Default.Close else Icons.Default.Menu,
            contentDescription = if (expanded) expandedContentDescription else collapsedContentDescription,
            tint = MaterialTheme.colorScheme.onPrimaryContainer,
            modifier = Modifier
                .fillMaxSize()
                .padding(MenuIconPadding)
                .rotate(rotation)
        )
    }
}

@Composable
private fun BoxScope.RadialMenuItems(
    items: List<MainMenuItem>,
    progress: Float,
    radius: Dp,
    arcDegrees: Float,
    startAngleDegrees: Float,
    anchorCorner: Corner,
    onItemClick: (MainMenuItem) -> Unit
) {
    if (items.isEmpty()) return

    val density = LocalDensity.current
    val radiusPx = with(density) { radius.toPx() }
    val itemSize = MenuItemSize
    val itemSizePx = with(density) { itemSize.toPx() }
    val innerPaddingPx = with(density) { MenuItemPadding.toPx() }
    val showItems = progress > 0.1f
    val enableItems = progress > 0.6f
    val iconRadius = (radiusPx - itemSizePx / 2f - innerPaddingPx).coerceAtLeast(0f)
    val maxOffsetPx = max(radiusPx * 2f - itemSizePx, 0f)

    items.forEachIndexed { index, item ->
        val fraction = if (items.size <= 1) 0.5f else index.toFloat() / (items.size - 1).coerceAtLeast(1)
        val orientedAngle = anchorCorner.orientAngle(startAngleDegrees + arcDegrees * fraction)
        val radian = orientedAngle * PI.toFloat() / 180f
        val rawX = radiusPx + cos(radian) * iconRadius - itemSizePx / 2f
        val rawY = radiusPx + sin(radian) * iconRadius - itemSizePx / 2f
        val clampedX = rawX.coerceIn(0f, maxOffsetPx)
        val clampedY = rawY.coerceIn(0f, maxOffsetPx)

        val alpha by animateFloatAsState(
            targetValue = if (showItems) 1f else 0f,
            animationSpec = tween(durationMillis = 200, delayMillis = index * 35, easing = FastOutSlowInEasing),
            label = "menuItemAlpha$index"
        )
        val scale by animateFloatAsState(
            targetValue = if (showItems) 1f else 0.6f,
            animationSpec = tween(durationMillis = 220, delayMillis = index * 35, easing = FastOutSlowInEasing),
            label = "menuItemScale$index"
        )

        val interactionSource = remember { MutableInteractionSource() }

        Surface(
            modifier = Modifier
                .offset { IntOffset(clampedX.roundToInt(), clampedY.roundToInt()) }
                .size(itemSize)
                .graphicsLayer {
                    this.alpha = alpha
                    this.scaleX = scale
                    this.scaleY = scale
                }
                .focusable(enabled = enableItems),
            shape = CircleShape,
            tonalElevation = 3.dp,
            color = MaterialTheme.colorScheme.surface
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surface)
                    .clickable(
                        interactionSource = interactionSource,
                        indication = rememberRipple(bounded = true, radius = itemSize / 2),
                        enabled = enableItems,
                        role = Role.Button
                    ) { onItemClick(item) },
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = item.icon,
                    contentDescription = item.label,
                    tint = MaterialTheme.colorScheme.primary
                )
            }
        }
    }
}

private val MenuItemSize = 56.dp
private val MenuItemPadding = 12.dp
private val MenuToggleSize = 56.dp
private val MenuIconPadding = 12.dp
private val MenuOuterMargin = 32.dp

private fun Corner.horizontalDirection(): Float = when (this) {
    Corner.TopLeft, Corner.BottomLeft -> 1f
    Corner.TopRight, Corner.BottomRight -> -1f
}

private fun Corner.verticalDirection(): Float = when (this) {
    Corner.TopLeft, Corner.TopRight -> 1f
    Corner.BottomLeft, Corner.BottomRight -> -1f
}

private fun Corner.orientAngle(angle: Float): Float = when (this) {
    Corner.TopLeft -> angle
    Corner.TopRight -> 180f - angle
    Corner.BottomLeft -> 360f - angle
    Corner.BottomRight -> 180f + angle
}.let(::normalizeAngle)

private fun Corner.orientArc(start: Float, sweep: Float): Pair<Float, Float> {
    val end = start + sweep
    val (rawStart, rawEnd) = when (this) {
        Corner.TopLeft -> start to end
        Corner.TopRight -> (180f - end) to (180f - start)
        Corner.BottomLeft -> (360f - end) to (360f - start)
        Corner.BottomRight -> (180f + start) to (180f + end)
    }
    val orientedStart = normalizeAngle(rawStart)
    val orientedEnd = normalizeAngle(rawEnd)
    val sweepAngle = ((orientedEnd - orientedStart).let { if (it < 0f) it + 360f else it }).coerceAtMost(360f)
    return orientedStart to sweepAngle
}

private fun normalizeAngle(value: Float): Float {
    var result = value % 360f
    if (result < 0f) result += 360f
    return result
}

@Preview
@Composable
private fun SemiCircularHamburgerMenuPreview() {
    MaterialTheme {
        Box(modifier = Modifier.fillMaxSize()) {
            SemiCircularHamburgerMenu(
                items = previewMenuItems(),
                collapsedContentDescription = "Abrir menú",
                expandedContentDescription = "Cerrar menú",
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 16.dp, end = 16.dp)
            )
        }
    }
}

@Preview
@Composable
private fun SemiCircularHamburgerMenuExpandedPreview() {
    MaterialTheme {
        Box(modifier = Modifier.fillMaxSize()) {
            SemiCircularHamburgerMenu(
                items = previewMenuItems(),
                collapsedContentDescription = "Abrir menú",
                expandedContentDescription = "Cerrar menú",
                initiallyExpanded = true,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 16.dp, end = 16.dp)
            )
        }
    }
}

private fun previewMenuItems(): List<MainMenuItem> = listOf(
    MainMenuItem(
        id = "demo",
        label = "Demo",
        icon = Icons.Default.AutoAwesome,
        onClick = {}
    ),
    MainMenuItem(
        id = "security",
        label = "Seguridad",
        icon = Icons.Default.Lock,
        onClick = {}
    ),
    MainMenuItem(
        id = "logout",
        label = "Salir",
        icon = Icons.Default.ExitToApp,
        onClick = {}
    )
)
