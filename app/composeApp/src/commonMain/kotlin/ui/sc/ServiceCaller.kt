package ui.sc

import androidx.compose.material3.SnackbarHostState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

private val logger = LoggerFactory.default.newLogger("ui.sc", "ServiceCaller")

fun <T> callService(
    coroutineScope: CoroutineScope,
    snackbarHostState: SnackbarHostState,
    setLoading: (Boolean) -> Unit,
    serviceCall: suspend () -> Result<T>,
    onSuccess: (T) -> Unit,
    onError: suspend (Throwable) -> Unit = { snackbarHostState.showSnackbar(it.message ?: "Error") }
) {
    coroutineScope.launch {
        logger.info { "Iniciando llamada de servicio" }
        setLoading(true)
        val result = serviceCall()
        result.onSuccess {
            logger.info { "Servicio exitoso" }
            setLoading(false)
            onSuccess(it)
        }.onFailure { error ->
            logger.error(error) { "Error en servicio" }
            setLoading(false)
            onError(error)
        }
    }
}
