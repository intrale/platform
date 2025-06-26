plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.ktor)
    alias(libs.plugins.shadow)
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(libs.ktor.server.core)
    implementation(libs.logback.classic)
    implementation(libs.kodein.di)
    implementation(libs.kodein.di.framework.ktor.server.jvm)
    implementation(libs.ktor.server.rate.limiting)
    implementation(libs.java.jwt)
    implementation(libs.jwks.rsa)
    implementation(libs.gson)

    testImplementation(kotlin("test"))
    testImplementation(libs.ktor.server.tests)
    testImplementation(libs.mockk)
}
