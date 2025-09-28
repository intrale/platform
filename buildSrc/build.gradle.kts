@file:Suppress("UnstableApiUsage")

// Nota: Las versiones deben gestionarse exclusivamente desde gradle/libs.versions.toml.

plugins {
    alias(libs.plugins.kotlin.jvm)
}

repositories {
    mavenCentral()
    gradlePluginPortal()
}

dependencies {
    implementation(gradleApi())
    implementation(localGroovy())
    implementation(libs.kotlin.stdlib.jvm)
    testImplementation(libs.kotlin.test.base)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.ktor.client.core.jvm.stable)
    implementation(libs.ktor.client.cio.stable)
}

tasks.test {
    useJUnitPlatform()
}
