package ui.cp.menu

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.focus.focusable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.consumePositionChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
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
 * Muestra un menú en forma de semicírculo que se despliega desde la esquina superior izquierda.
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

    val radius by animateDpAsState(
        targetValue = collapsedRadius + (expandedRadius - collapsedRadius) * displayedProgress,
        animationSpec = spring(
            dampingRatio = Spring.DampingRatioMediumBouncy,
            stiffness = Spring.StiffnessMediumLow
        ),
        label = "semiCircularMenuRadius"
    )
    val sweepAngle by animateFloatAsState(
        targetValue = arcDegrees * (0.25f + 0.75f * displayedProgress),
        animationSpec = tween(durationMillis = 240, easing = FastOutSlowInEasing),
        label = "semiCircularMenuSweep"
    )
    val toggleRotation by animateFloatAsState(
        targetValue = if (expanded) 0f else -90f,
        animationSpec = tween(durationMillis = 220, easing = FastOutSlowInEasing),
        label = "semiCircularMenuToggleRotation"
    )

    val density = LocalDensity.current
    val dragRangePx = remember(collapsedRadius, expandedRadius, density) {
        max(1f, with(density) { (expandedRadius - collapsedRadius).coerceAtLeast(0.dp).toPx() })
    }

    LaunchedEffect(expanded, displayedProgress, isDragging) {
        if (!isDragging) {
            if (expanded && displayedProgress >= 0.99f) {
                updateState(MenuState.Expanded)
                hapticFeedback.performHapticFeedback(HapticFeedbackType.TextHandleMove)
            } else if (!expanded && displayedProgress <= 0.01f) {
                updateState(MenuState.Collapsed)
            }
        }
    }

    Box(modifier = modifier) {
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
            modifier = Modifier
                .align(Alignment.TopStart)
                .size(expandedRadius * 2f)
        ) {
            Box(
                modifier = Modifier
                    .size(radius * 2f)
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
                            val weightedDelta = dragAmount.x * 0.7f + dragAmount.y * 0.3f
                            dragProgress = (dragProgress + weightedDelta / dragRangePx).coerceIn(0f, 1f)
                            change.consumePositionChange()
                        }
                    }
            ) {
                Canvas(modifier = Modifier.matchParentSize()) {
                    drawSemiCircle(
                        sweepAngle = sweepAngle.coerceIn(0f, arcDegrees),
                        startAngle = startAngleDegrees,
                        color = MaterialTheme.colorScheme.primary
                    )
                }

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
                    arcDegrees = arcDegrees,
                    startAngleDegrees = startAngleDegrees
                ) { item ->
                    collapseMenu()
                    onItemSelected?.invoke(item)
                    item.onClick()
                }
            }
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawSemiCircle(
    sweepAngle: Float,
    startAngle: Float,
    color: Color,
) {
    val diameter = minOf(size.width, size.height)
    drawArc(
        color = color,
        startAngle = startAngle,
        sweepAngle = sweepAngle,
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
            .size(56.dp),
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
                .padding(12.dp)
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
    onItemClick: (MainMenuItem) -> Unit
) {
    if (items.isEmpty()) return

    val density = LocalDensity.current
    val radiusPx = with(density) { radius.toPx() }
    val itemSize = 56.dp
    val itemSizePx = with(density) { itemSize.toPx() }
    val showItems = progress > 0.1f
    val enableItems = progress > 0.6f

    items.forEachIndexed { index, item ->
        val fraction = if (items.size <= 1) 0.5f else index.toFloat() / (items.size - 1).coerceAtLeast(1)
        val angle = startAngleDegrees + arcDegrees * fraction
        val radian = angle * PI / 180f
        val center = radiusPx
        val x = center + cos(radian) * radiusPx - itemSizePx / 2f
        val y = center + sin(radian) * radiusPx - itemSizePx / 2f

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
                .offset { IntOffset(x.roundToInt(), y.roundToInt()) }
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

@Preview
@Composable
private fun SemiCircularHamburgerMenuPreview() {
    MaterialTheme {
        Box(modifier = Modifier.fillMaxSize()) {
            SemiCircularHamburgerMenu(
                items = previewMenuItems(),
                collapsedContentDescription = "Abrir menú",
                expandedContentDescription = "Cerrar menú",
                modifier = Modifier.fillMaxSize()
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
                modifier = Modifier.fillMaxSize()
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
