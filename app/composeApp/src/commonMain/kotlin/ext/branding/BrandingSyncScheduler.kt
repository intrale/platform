package ext.branding

import ext.storage.CommKeyValueStorage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

class BrandingSyncScheduler(
    private val storage: CommKeyValueStorage,
    private val scope: CoroutineScope
) {
    private var job: Job? = null

    fun start(intervalDays: Int, onTick: () -> Unit) {
        job?.cancel()
        job = scope.launch {
            storage.brandingLastCheck = currentTimestamp()
            onTick()
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    private fun currentTimestamp(): String = "1970-01-01T00:00:00Z"
}
