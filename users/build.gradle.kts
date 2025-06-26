plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.ktor)
    alias(libs.plugins.shadow)
}

kotlin {
    jvmToolchain(21)
}
