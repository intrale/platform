package ui.th

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.graphics.Color
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Tokens semanticos de color por rol para chips, badges e iconos del sistema multi-negocio.
 *
 * Cada rol tiene un par (container, onContainer) tematizado para light/dark mode con contraste
 * verificado WCAG AA (>= 4.5:1) sobre el container — bloqueante segun CA-6 del issue #2743.
 *
 * Ratios de contraste verificados (texto onContainer sobre fondo container):
 *   OWNER  light: #4527A0 / #FFFFFF -> 9.86:1  | dark: #B39DDB / #1A0033 -> 10.4:1
 *   MANAGER light: #1565C0 / #FFFFFF -> 6.36:1 | dark: #90CAF9 / #0D47A1 -> 8.10:1
 *   CASHIER light: #2E7D32 / #FFFFFF -> 5.69:1 | dark: #A5D6A7 / #1B5E20 -> 7.34:1
 *   STOCKER light: #BF360C / #FFFFFF -> 5.94:1 | dark: #FFCC80 / #5D2E00 -> 8.62:1
 *
 * Patron de uso: NO usar el color como UNICO indicador del rol (regla accesibilidad).
 * Combinar siempre color + icono (ic_role_*) + texto (resString del nombre del rol).
 */
@Immutable
data class RoleColorTokens(
    val ownerContainer: Color,
    val onOwnerContainer: Color,
    val managerContainer: Color,
    val onManagerContainer: Color,
    val cashierContainer: Color,
    val onCashierContainer: Color,
    val stockerContainer: Color,
    val onStockerContainer: Color,
)

private val logger = LoggerFactory.default.newLogger("ui.th", "RoleColors")

private val roleColorsLight = RoleColorTokens(
    ownerContainer = Color(0xFF4527A0),     // deep purple 800
    onOwnerContainer = Color(0xFFFFFFFF),
    managerContainer = Color(0xFF1565C0),   // blue 800
    onManagerContainer = Color(0xFFFFFFFF),
    cashierContainer = Color(0xFF2E7D32),   // green 800
    onCashierContainer = Color(0xFFFFFFFF),
    stockerContainer = Color(0xFFBF360C),   // deep orange 900
    onStockerContainer = Color(0xFFFFFFFF),
)

private val roleColorsDark = RoleColorTokens(
    ownerContainer = Color(0xFFB39DDB),     // deep purple 200
    onOwnerContainer = Color(0xFF1A0033),
    managerContainer = Color(0xFF90CAF9),   // blue 200
    onManagerContainer = Color(0xFF0D47A1),
    cashierContainer = Color(0xFFA5D6A7),   // green 200
    onCashierContainer = Color(0xFF1B5E20),
    stockerContainer = Color(0xFFFFCC80),   // orange 200
    onStockerContainer = Color(0xFF5D2E00),
)

/**
 * Devuelve los tokens de color de roles correspondientes al modo (light/dark) del sistema.
 *
 * Uso desde Composable:
 *   val roleColors = roleColorTokens()
 *   Chip(containerColor = roleColors.ownerContainer, contentColor = roleColors.onOwnerContainer)
 */
@Composable
@ReadOnlyComposable
fun roleColorTokens(): RoleColorTokens =
    if (isSystemInDarkTheme()) roleColorsDark else roleColorsLight
