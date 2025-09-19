package ui.sc.shared

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.StringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

abstract class Screen (val route: String, val title: StringResource) {

    protected val screenLogger = LoggerFactory.default.newLogger<Screen>()

    lateinit var navigator: (route:String) -> Unit

    fun navigate(route:String){
        screenLogger.info { "Navegando a $route" }
        try {
            navigator(route)
        }catch (e: Exception){
            screenLogger.error(e) { "Error al navegar a $route" }
        }
    }

    @Composable
    abstract fun screen()

}