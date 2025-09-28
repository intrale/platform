@file:Suppress("UnstableApiUsage")

// Nota: Las versiones deben gestionarse exclusivamente desde gradle/libs.versions.toml.

plugins {
    alias(libs.plugins.kotlin.jvm)
}

val ktorClientVersion = libs.ktor.client.core.jvm.stable.get().versionConstraint.requiredVersion.removeSuffix("-wasm2")

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
    implementation("io.ktor:ktor-client-core:$ktorClientVersion")
    implementation("io.ktor:ktor-client-cio:$ktorClientVersion")
}

tasks.test {
    useJUnitPlatform()
}
