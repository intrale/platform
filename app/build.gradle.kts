plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.compose)
    id("com.android.library") version "8.3.0"
}

kotlin {
    jvmToolchain(21)
    androidTarget()
    ios()
    iosSimulatorArm64()
    wasmJs {
        browser()
    }
}

android {
    namespace = "com.example.app"
    compileSdk = 34
    defaultConfig {
        minSdk = 24
    }
}
