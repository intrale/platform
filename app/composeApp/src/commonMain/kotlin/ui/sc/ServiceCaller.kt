package ui.sc

import androidx.compose.material3.SnackbarHostState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

fun <T> callService(
    coroutineScope: CoroutineScope,
    snackbarHostState: SnackbarHostState,
    setLoading: (Boolean) -> Unit,
    serviceCall: suspend () -> Result<T>,
    onSuccess: (T) -> Unit,
    onError: suspend (Throwable) -> Unit = { snackbarHostState.showSnackbar(it.message ?: "Error") }
) {
    coroutineScope.launch {
        setLoading(true)
        val result = serviceCall()
        result.onSuccess {
            setLoading(false)
            onSuccess(it)
        }.onFailure { error ->
            setLoading(false)
            onError(error)
        }
    }
}
