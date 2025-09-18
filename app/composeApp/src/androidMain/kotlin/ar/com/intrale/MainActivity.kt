package ar.com.intrale

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import ui.App
import ui.metrics.AndroidJankStatsMonitor

class MainActivity : ComponentActivity() {
    private var jankStatsMonitor: AndroidJankStatsMonitor? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        jankStatsMonitor = AndroidJankStatsMonitor(window).also { it.start() }

        setContent {
            App()
        }
    }

    override fun onDestroy() {
        jankStatsMonitor?.stop()
        jankStatsMonitor = null
        super.onDestroy()
    }
}

@Preview
@Composable
fun AppAndroidPreview() {
    App()
}