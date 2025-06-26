val artifactId = "backend"
group = "ar.com.intrale"

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.ktor)
    alias(libs.plugins.shadow)
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass.set("$group.ApplicationKt")
}


dependencies {
    implementation(libs.ktor.server.core)
    implementation(libs.ktor.server.netty)
    //implementation(libs.ktor.server.rate.limiting)
    implementation(libs.kodein.di.framework.ktor.server.jvm)

    //testImplementation(kotlin("test"))
    testImplementation(libs.ktor.server.test.host)
    testImplementation(libs.mockk)
    testImplementation(libs.ktor.client.cio)
    testImplementation(libs.kotlin.test.junit)

    // Logging
    implementation(libs.logback.classic)

    // JWT and JSON
    implementation(libs.java.jwt)
    implementation(libs.jwks.rsa)
    implementation(libs.gson)

    implementation(libs.logback.classic)

    // AWS Lambdas
    implementation(libs.aws.lambda.java.core)
    implementation(libs.aws.lambda.java.events)
    implementation(libs.aws.lambda.java.log4j)

    // AWS Cognito
    implementation(libs.cognito.identity.provider)
    implementation(libs.cognito.identity)
    implementation(libs.secretsmanager)

    // serialization
    implementation(libs.kotlinx.serialization.json)

    // Validations
    implementation(libs.konform)

    // Dependency Injection
    implementation(libs.kodein.di)
    //implementation(libs.kodein.di.framework.ktor.server.jvm)

    // Faker
    implementation(libs.datafaker)

    //JWT
    implementation(libs.java.jwt)
    implementation(libs.jwks.rsa)

}
