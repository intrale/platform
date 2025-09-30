package ar.com.intrale

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import ui.App

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        logBrandContext()

        setContent {
            App()
        }
    }

    private fun logBrandContext() {
        val brandId = BuildConfig.BRAND_ID
        val applicationId = BuildConfig.APPLICATION_ID
        Log.i(TAG, "Brand context — BRAND_ID=$brandId, applicationId=$applicationId")
    }

    companion object {
        private const val TAG = "IntraleBrandCheck"
    }
}

@Preview
@Composable
fun AppAndroidPreview() {
    App()
}