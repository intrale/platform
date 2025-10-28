plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.ktor) apply false
    alias(libs.plugins.shadow) apply false

    alias(libs.plugins.ksp) apply false

    // Plugins for Multiplatform projects
    alias(libs.plugins.androidApplication) apply false
    alias(libs.plugins.androidLibrary) apply false
    alias(libs.plugins.composeHotReload) apply false
    alias(libs.plugins.composeMultiplatform) apply false
    alias(libs.plugins.composeCompiler) apply false
    alias(libs.plugins.kotlinMultiplatform) apply false
}