package ui.metrics

import android.os.Handler
import android.os.Looper
import android.view.Window
import androidx.metrics.performance.JankStats
import diagnostics.FramePerformanceDiagnostics
import org.kodein.log.Logger
import org.kodein.log.LoggerFactory
import org.kodein.log.warning
import org.kodein.log.newLogger
import java.util.concurrent.Executor

class AndroidJankStatsMonitor(
    private val window: Window,
    loggerFactory: LoggerFactory = LoggerFactory.default
) {
    private val logger: Logger = loggerFactory.newLogger("ui.metrics", "JankStatsMonitor")
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executor { runnable -> handler.post(runnable) }
    private var jankStats: JankStats? = null
    private var totalFrames = 0
    private var jankFrames = 0

    fun start() {
        if (jankStats != null) return
        totalFrames = 0
        jankFrames = 0
        FramePerformanceDiagnostics.reset()
        jankStats = JankStats.createAndTrack(window, executor) { frameData ->
            totalFrames += 1
            if (frameData.isJank) {
                jankFrames += 1
                val durationMs = frameData.frameDurationUiNanos / 1_000_000f
                logger.warning { "Frame janky (${String.format("%.2f", durationMs)} ms) estados=${frameData.states}" }
            }
            FramePerformanceDiagnostics.report(totalFrames, jankFrames)
        }.also {
            it.isTrackingEnabled = true
        }
        logger.info { "JankStats inicializado" }
    }

    fun stop() {
        jankStats?.stopTracking()
        jankStats = null
        logger.info { "JankStats detenido" }
    }
}
