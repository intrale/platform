package ui.sc.shared

import androidx.compose.runtime.Composable
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import org.jetbrains.compose.resources.StringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.util.RES_ERROR_PREFIX
import ui.util.fb
import ui.util.resString

abstract class Screen(
    val route: String,
    val title: StringResource? = null,
) {

    open val messageTitle: MessageKey? = null

    protected val screenLogger = LoggerFactory.default.newLogger<Screen>()

    lateinit var navigator: (route:String) -> Unit
    var navigateBack: (() -> Boolean)? = null

    fun navigate(route:String){
        screenLogger.info { "Navegando a $route" }
        try {
            navigator(route)
        }catch (e: Exception){
            screenLogger.error(e) { "Error al navegar a $route" }
        }
    }

    fun goBack(): Boolean {
        screenLogger.info { "Solicitando navegación hacia atrás" }
        return try {
            navigateBack?.invoke() ?: false
        } catch (e: Exception) {
            screenLogger.error(e) { "Error al navegar hacia atrás" }
            false
        }
    }

    @Composable
    abstract fun screen()

    @Composable
    open fun titleText(): String {
        messageTitle?.let { return Txt(it) }
        title?.let {
            return resString(
                composeId = it,
                fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Pantalla sin titulo"),
            )
        }
        return Txt(MessageKey.app_missing_title)
    }
}
