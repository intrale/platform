package ui.sc.business

import DIManager
import asdo.auth.ToDoResetLoginCache
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class DashboardViewModel : ViewModel() {

    private val toDoResetLoginCache: ToDoResetLoginCache by DIManager.di.instance()

    private val logger = LoggerFactory.default.newLogger<DashboardViewModel>()

    override fun getState(): Any = Unit

    override fun initInputState() { /* No-op */ }

    suspend fun logout() {
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
