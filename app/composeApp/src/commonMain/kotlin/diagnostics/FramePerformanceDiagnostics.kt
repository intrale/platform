package diagnostics

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

@Immutable
data class FramePerformanceSnapshot(
    val totalFrames: Int,
    val jankFrames: Int
)

object FramePerformanceDiagnostics {
    private val _snapshot = MutableStateFlow(FramePerformanceSnapshot(totalFrames = 0, jankFrames = 0))
    val snapshot: StateFlow<FramePerformanceSnapshot> = _snapshot

    fun report(totalFrames: Int, jankFrames: Int) {
        _snapshot.value = FramePerformanceSnapshot(totalFrames = totalFrames, jankFrames = jankFrames)
    }

    fun reset() {
        _snapshot.value = FramePerformanceSnapshot(totalFrames = 0, jankFrames = 0)
    }
}
