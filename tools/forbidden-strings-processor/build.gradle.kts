plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
}

dependencies {

    // Opcional pero recomendado: BOM para alinear artefactos Kotlin
    implementation(platform(libs.kotlin.bom))

    // Usa las libs del catálogo (no hardcodees "2.2.0" acá):
    compileOnly(libs.kotlin.stdlib)
    compileOnly(libs.kotlin.reflect)

    // KSP API alineado por catálogo
    compileOnly(libs.ksp.api)

    implementation("com.google.devtools.ksp:symbol-processing-api:2.2.0-2.0.2")
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}
