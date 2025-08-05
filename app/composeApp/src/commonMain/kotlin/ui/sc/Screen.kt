package ui.sc

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.StringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

abstract class Screen (val route: String, val title: StringResource) {

    private val logger = LoggerFactory.default.newLogger<Screen>()

    lateinit var navigator: (route:String) -> Unit

    fun navigate(route:String){
        logger.info { "Navegando a $route" }
        try {
            navigator(route)
        }catch (e: Exception){
            logger.error(e) { "Error al navegar a $route" }
        }
    }

    @Composable
    abstract fun screen()

}