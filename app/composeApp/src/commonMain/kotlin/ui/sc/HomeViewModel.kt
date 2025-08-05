package ui.sc

import DIManager
import asdo.ToDoResetLoginCache
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class HomeViewModel : ViewModel()  {


    private val toDoResetLoginCache: ToDoResetLoginCache by DIManager.di.instance()

    private val logger = LoggerFactory.default.newLogger<HomeViewModel>()

    // data state initialize
    override fun getState(): Any  = Unit

    override fun initInputState() { /* Do nothing */ }

    suspend fun logout(){
        logger.info { "Ejecutando logout" }
        try {
            toDoResetLoginCache.execute()
            logger.info { "Logout completado" }
        } catch (e: Throwable) {
            logger.error(e) { "Error al ejecutar logout" }
            throw e
        }
    }
}