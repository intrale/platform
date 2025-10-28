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

abstract class Screen(val route: String, val title: ScreenTitle) {

    constructor(route: String, title: StringResource) : this(route, ScreenTitle.Resource(title))

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

}

sealed interface ScreenTitle {
    @Composable
    fun resolve(): String

    data class Resource(private val value: StringResource) : ScreenTitle {
        @Composable
        override fun resolve(): String = resString(
            composeId = value,
            fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Pantalla sin titulo"),
        )
    }

    data class Message(
        private val key: MessageKey,
        private val params: Map<String, String> = emptyMap(),
    ) : ScreenTitle {
        @Composable
        override fun resolve(): String = Txt(key, params)
    }
}