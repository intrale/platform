@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

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
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.indication
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
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.consumePositionChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.lerp
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import org.jetbrains.compose.ui.tooling.preview.Preview
import kotlinx.coroutines.delay

/**
 * Representa una acción dentro del menú semicircular.
 */
data class MainMenuItem(
    val id: String,
    val label: String,
    val icon: ImageVector,
    val requiredRoles: Set<String> = emptySet(),
    val requiresBusinessSelection: Boolean = false,
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

private data class DragSample(val dx: Float, val dy: Float, val velocity: Float) {
    companion object {
        val Zero = DragSample(0f, 0f, 0f)
    }
}

private fun angleDeg(dx: Float, dy: Float): Float =
    atan2(dy, dx) * (180f / PI.toFloat())

private fun magnitude(dx: Float, dy: Float): Float = hypot(dx, dy)

private fun isRightSwipe(dx: Float, dy: Float, minDist: Float, angle: Float): Boolean =
    magnitude(dx, dy) >= minDist && angle in -35f..35f

private fun isDownSwipe(dx: Float, dy: Float, minDist: Float, angle: Float): Boolean =
    magnitude(dx, dy) >= minDist && angle in 55f..125f

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
    onBack: (() -> Unit)? = null,
    collapsedLongPressHint: String? = null,
) {
    val filteredItems = remember(items) { items.distinctBy(MainMenuItem::id) }
    val hapticFeedback = LocalHapticFeedback.current

    var expanded by rememberSaveable { mutableStateOf(initiallyExpanded) }
    var dragProgress by remember { mutableStateOf(if (initiallyExpanded) 1f else 0f) }
    var isDragging by remember { mutableStateOf(false) }
    var menuState by remember { mutableStateOf(if (initiallyExpanded) MenuState.Expanded else MenuState.Collapsed) }
    var focusFirstItem by remember { mutableStateOf(initiallyExpanded) }
    var showLongPressHint by remember { mutableStateOf(false) }

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
        focusFirstItem = false
        showLongPressHint = false
        updateState(MenuState.Collapsing)
    }

    fun expandMenu() {
        expanded = true
        dragProgress = 1f
        isDragging = false
        focusFirstItem = true
        showLongPressHint = false
        updateState(MenuState.Expanding)
    }

    val displayedProgress = if (isDragging) dragProgress else if (expanded) 1f else 0f

    val infiniteTransition = rememberInfiniteTransition(label = "semiCircularMenuGlow")
    val glowRotationDegrees by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1600, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "semiCircularMenuGlowRotation"
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
        val currentSweepDegrees = sweepAngle.coerceIn(0f, effectiveArcDegrees)

        val toggleRotation by animateFloatAsState(
            targetValue = if (expanded) 0f else -90f,
            animationSpec = tween(durationMillis = 220, easing = FastOutSlowInEasing),
            label = "semiCircularMenuToggleRotation"
        )

        val dragRangePx = remember(collapsedRadius, effectiveExpandedRadius) {
            max(1f, with(density) { (effectiveExpandedRadius - collapsedRadius).coerceAtLeast(0.dp).toPx() })
        }
        val minSwipeDistancePx = with(density) { MinSwipeDistance.toPx() }
        val minFlingVelocity = MinFlingVelocity

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

        LaunchedEffect(showLongPressHint) {
            if (showLongPressHint) {
                delay(2200)
                showLongPressHint = false
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
                        .pointerInput(expanded, collapsedLongPressHint) {
                            detectTapGestures(
                                onTap = {
                                    showLongPressHint = false
                                    if (expanded) collapseMenu() else expandMenu()
                                },
                                onLongPress = {
                                    if (!expanded && collapsedLongPressHint != null) {
                                        showLongPressHint = true
                                    }
                                }
                            )
                        }
                        .pointerInput(
                            dragRangePx,
                            expanded,
                            anchorCorner,
                            minSwipeDistancePx,
                            minFlingVelocity,
                            onBack
                        ) {
                            var dragSample = DragSample.Zero
                            var gestureHandled = false
                            var velocityTracker: VelocityTracker? = null

                            fun handleBackGesture() {
                                gestureHandled = true
                                showLongPressHint = false
                                expanded = false
                                dragProgress = 0f
                                isDragging = false
                                updateState(MenuState.Collapsed)
                                hapticFeedback.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                velocityTracker = null
                                onBack?.invoke()
                            }

                            fun handleOpenGesture() {
                                gestureHandled = true
                                showLongPressHint = false
                                hapticFeedback.performHapticFeedback(HapticFeedbackType.LongPress)
                                velocityTracker = null
                                expandMenu()
                            }

                            detectDragGestures(
                                onDragStart = {
                                    isDragging = true
                                    dragProgress = if (expanded) 1f else 0f
                                    updateState(if (expanded) MenuState.Collapsing else MenuState.Expanding)
                                    dragSample = DragSample.Zero
                                    gestureHandled = false
                                    velocityTracker = VelocityTracker()
                                    showLongPressHint = false
                                },
                                onDragEnd = {
                                    velocityTracker = null
                                    if (!gestureHandled) {
                                        isDragging = false
                                        val shouldExpand = dragProgress > 0.4f
                                        if (shouldExpand) {
                                            expandMenu()
                                        } else {
                                            collapseMenu()
                                        }
                                    }
                                },
                                onDragCancel = {
                                    velocityTracker = null
                                    isDragging = false
                                    if (!gestureHandled) {
                                        dragProgress = if (expanded) 1f else 0f
                                        updateState(if (expanded) MenuState.Expanded else MenuState.Collapsed)
                                    }
                                }
                            ) { change, dragAmount ->
                                velocityTracker?.addPosition(change.uptimeMillis, change.position)
                                val velocityMagnitude = velocityTracker?.calculateVelocity()?.distance() ?: 0f

                                dragSample = DragSample(
                                    dx = dragSample.dx + dragAmount.x,
                                    dy = dragSample.dy + dragAmount.y,
                                    velocity = velocityMagnitude
                                )

                                if (!expanded && !gestureHandled) {
                                    val angle = angleDeg(dragSample.dx, dragSample.dy)
                                    val fast = dragSample.velocity >= minFlingVelocity
                                    when {
                                        fast && angle in -35f..35f -> handleBackGesture()
                                        fast && angle in 55f..125f -> handleOpenGesture()
                                        isRightSwipe(dragSample.dx, dragSample.dy, minSwipeDistancePx, angle) -> handleBackGesture()
                                        isDownSwipe(dragSample.dx, dragSample.dy, minSwipeDistancePx, angle) -> handleOpenGesture()
                                    }
                                }

                                if (!gestureHandled) {
                                    val weightedDelta =
                                        dragAmount.x * 0.7f * anchorCorner.horizontalDirection() +
                                            dragAmount.y * 0.3f * anchorCorner.verticalDirection()
                                    dragProgress = (dragProgress + weightedDelta / dragRangePx).coerceIn(0f, 1f)
                                }
                                change.consumePositionChange()
                            }
                        }
                ) {
                    val primaryColor = MaterialTheme.colorScheme.primary

                    Canvas(modifier = Modifier.matchParentSize()) {
                        val arcCenter = Offset(size.width / 2f, size.height / 2f)

                        fun Color.mix(other: Color, t: Float) = Color(
                            red = red * (1 - t) + other.red * t,
                            green = green * (1 - t) + other.green * t,
                            blue = blue * (1 - t) + other.blue * t,
                            alpha = alpha * (1 - t) + other.alpha * t
                        )

                        val colors = listOf(
                            primaryColor.mix(Color.White, 0.18f).copy(alpha = 0.95f),
                            primaryColor,
                            primaryColor.mix(Color.Black, 0.12f).copy(alpha = 0.95f)
                        )

                        val sweepBrush = Brush.sweepGradient(
                            colors = colors,
                            center = arcCenter
                        )

                        val (resolvedStart, resolvedSweep) = anchorCorner.orientArc(startAngleDegrees, currentSweepDegrees)
                        val path = buildWavyArcPath(
                            center = arcCenter,
                            radius = size.minDimension / 2f,
                            startDeg = resolvedStart,
                            sweepDeg = resolvedSweep,
                            waves = 12,
                            amplitudePx = 12.dp.toPx()
                        )

                        rotate(degrees = glowRotationDegrees) {
                            drawPath(path = path, brush = sweepBrush)
                        }
                    }

                    MenuToggleIcon(
                        expanded = expanded,
                        rotation = toggleRotation,
                        collapsedContentDescription = collapsedContentDescription,
                        expandedContentDescription = expandedContentDescription
                    )

                    if (!expanded && showLongPressHint && collapsedLongPressHint != null) {
                        LongPressHint(
                            message = collapsedLongPressHint,
                            anchorCorner = anchorCorner
                        )
                    }

                    RadialMenuItems(
                        items = filteredItems,
                        progress = displayedProgress,
                        radius = radius,
                        startAngleDegrees = startAngleDegrees,
                        currentSweepDegrees = currentSweepDegrees,
                        anchorCorner = anchorCorner,
                        beamRotationDegrees = glowRotationDegrees,
                        focusFirstItem = focusFirstItem,
                        onFirstItemFocused = { focusFirstItem = false }
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

private fun buildWavyArcPath(
    center: Offset,
    radius: Float,
    startDeg: Float,
    sweepDeg: Float,
    waves: Int,
    amplitudePx: Float
): Path {
    val path = Path()
    val startRad = startDeg.toDouble() * PI / 180.0
    val endRad = (startDeg + sweepDeg).toDouble() * PI / 180.0
    val steps = max(36, waves * 12)

    path.moveTo(center.x, center.y)

    for (i in 0..steps) {
        val t = i / steps.toFloat()
        val angle = startRad + (endRad - startRad) * t
        val wave = sin(2.0 * PI * t * waves).toFloat()
        val r = radius + wave * amplitudePx
        val x = center.x + cos(angle).toFloat() * r
        val y = center.y + sin(angle).toFloat() * r
        path.lineTo(x, y)
    }

    path.close()
    return path
}

private fun polarToCartesian(center: Offset, radius: Float, deg: Float): Offset {
    val rad = deg.toDouble() * PI / 180.0
    val x = center.x + cos(rad).toFloat() * radius
    val y = center.y + sin(rad).toFloat() * radius
    return Offset(x, y)
}

private fun angularDistance(a: Float, b: Float): Float {
    var delta = (a - b) % 360f
    if (delta < -180f) delta += 360f
    if (delta > 180f) delta -= 360f
    return abs(delta)
}

@Composable
private fun BoxScope.MenuToggleIcon(
    expanded: Boolean,
    rotation: Float,
    collapsedContentDescription: String,
    expandedContentDescription: String,
) {
    val nudgeAlpha by rememberInfiniteTransition(label = "menuNudge")
        .animateFloat(
            initialValue = 0.15f,
            targetValue = 0.45f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 1200, easing = FastOutSlowInEasing),
                repeatMode = RepeatMode.Reverse
            ),
            label = "menuNudgeAlpha"
        )

    Box(modifier = Modifier.align(Alignment.Center)) {
        Surface(
            modifier = Modifier.size(MenuToggleSize),
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

        if (!expanded) {
            val tint = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = nudgeAlpha)
            Icon(
                imageVector = Icons.Default.KeyboardArrowRight,
                contentDescription = null,
                tint = tint,
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .offset(x = MenuNudgeOffset)
            )
            Icon(
                imageVector = Icons.Default.KeyboardArrowDown,
                contentDescription = null,
                tint = tint,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .offset(y = MenuNudgeOffset)
            )
        }
    }
}

@Composable
private fun BoxScope.LongPressHint(
    message: String,
    anchorCorner: Corner,
) {
    val alignment = if (anchorCorner.isTop()) Alignment.TopCenter else Alignment.BottomCenter
    val verticalOffset = if (anchorCorner.isTop()) -MenuToggleSize else MenuToggleSize
    val horizontalOffset = when {
        anchorCorner.isLeft() -> MenuToggleSize / 2
        anchorCorner.isRight() -> -(MenuToggleSize / 2)
        else -> 0.dp
    }

    Surface(
        modifier = Modifier
            .align(alignment)
            .offset(x = horizontalOffset, y = verticalOffset)
            .wrapContentSize(),
        shape = RoundedCornerShape(12.dp),
        tonalElevation = 4.dp,
        shadowElevation = 8.dp,
        color = MaterialTheme.colorScheme.surfaceVariant
    ) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp)
        )
    }
}

@Composable
private fun BoxScope.RadialMenuItems(
    items: List<MainMenuItem>,
    progress: Float,
    radius: Dp,
    startAngleDegrees: Float,
    currentSweepDegrees: Float,
    anchorCorner: Corner,
    beamRotationDegrees: Float,
    focusFirstItem: Boolean,
    onFirstItemFocused: () -> Unit,
    onItemClick: (MainMenuItem) -> Unit
) {
    if (items.isEmpty()) return

    val density = LocalDensity.current
    val radiusPx = with(density) { radius.toPx() }
    val arcCenter = Offset(radiusPx, radiusPx)
    val itemSize = MenuItemSize
    val itemSizePx = with(density) { itemSize.toPx() }
    val innerPaddingPx = with(density) { MenuItemPadding.toPx() }
    val showItems = progress > 0.1f
    val enableItems = progress > 0.6f
    val ringRadius = (radiusPx - itemSizePx / 2f - innerPaddingPx).coerceAtLeast(0f)
    val orientedBeam = anchorCorner.orientAngle(startAngleDegrees + beamRotationDegrees)
    val sigma = 24f

    items.forEachIndexed { index, item ->
        val angularStep = currentSweepDegrees / (items.size + 1)
        val baseAngle = startAngleDegrees + (index + 1) * angularStep
        val orientedAngle = anchorCorner.orientAngle(baseAngle)
        val position = polarToCartesian(arcCenter, ringRadius, orientedAngle)
        val offset = IntOffset(
            (position.x - itemSizePx / 2f).roundToInt(),
            (position.y - itemSizePx / 2f).roundToInt()
        )

        val baseAlpha by animateFloatAsState(
            targetValue = if (showItems) 1f else 0f,
            animationSpec = tween(durationMillis = 200, delayMillis = index * 35, easing = FastOutSlowInEasing),
            label = "menuItemAlpha$index"
        )
        val baseScale by animateFloatAsState(
            targetValue = if (showItems) 1f else 0.6f,
            animationSpec = tween(durationMillis = 220, delayMillis = index * 35, easing = FastOutSlowInEasing),
            label = "menuItemScale$index"
        )

        val delta = angularDistance(orientedAngle, orientedBeam)
        val intensity = exp(-(delta * delta) / (2f * sigma * sigma))
        val highlightScale = 0.96f + 0.10f * intensity
        val highlightAlpha = 0.80f + 0.20f * intensity

        val interactionSource = remember(item.id) { MutableInteractionSource() }
        val focusRequester = if (index == 0) remember { FocusRequester() } else null
        val shouldRequestFocus = focusFirstItem && index == 0 && enableItems

        if (focusRequester != null) {
            LaunchedEffect(shouldRequestFocus) {
                if (shouldRequestFocus) {
                    focusRequester.requestFocus()
                    onFirstItemFocused()
                }
            }
        }

        Surface(
            modifier = Modifier
                .offset { offset }
                .size(itemSize)
                .graphicsLayer {
                    val appliedScale = baseScale * highlightScale
                    this.alpha = baseAlpha * highlightAlpha
                    this.scaleX = appliedScale
                    this.scaleY = appliedScale
                }
                .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
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
                    .indication(
                        interactionSource = interactionSource,
                        indication = ripple(bounded = true)
                    )
                    .clickable(
                        interactionSource = interactionSource,
                        indication = null,
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
private val MenuNudgeOffset = 28.dp
private val MinSwipeDistance = 24.dp
private const val MinFlingVelocity = 1200f

private fun Corner.horizontalDirection(): Float = when (this) {
    Corner.TopLeft, Corner.BottomLeft -> 1f
    Corner.TopRight, Corner.BottomRight -> -1f
}

private fun Corner.verticalDirection(): Float = when (this) {
    Corner.TopLeft, Corner.TopRight -> 1f
    Corner.BottomLeft, Corner.BottomRight -> -1f
}

private fun Corner.isTop(): Boolean = this == Corner.TopLeft || this == Corner.TopRight

private fun Corner.isLeft(): Boolean = this == Corner.TopLeft || this == Corner.BottomLeft

private fun Corner.isRight(): Boolean = !isLeft()

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

private fun Velocity.distance(): Float = hypot(x.toDouble(), y.toDouble()).toFloat()

@Preview
@Composable
private fun SemiCircularHamburgerMenuPreview() {
    MaterialTheme {
        Box(modifier = Modifier.fillMaxSize()) {
            SemiCircularHamburgerMenu(
                items = previewMenuItems(),
                collapsedContentDescription = "Abrir menú",
                expandedContentDescription = "Cerrar menú",
                onBack = {},
                collapsedLongPressHint = "Desliza a la derecha para volver · hacia abajo para abrir",
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
                onBack = {},
                collapsedLongPressHint = "Desliza a la derecha para volver · hacia abajo para abrir",
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
