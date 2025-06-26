plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.ktor)
    alias(libs.plugins.shadow)
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass.set("ar.com.intrale.UsersApplicationKt")
}

dependencies {
    implementation(project(":backend"))

    implementation(libs.ktor.server.core)
    implementation(libs.logback.classic)
    implementation(libs.kodein.di)
    implementation(libs.kodein.di.framework.ktor.server.jvm)
    implementation(libs.cognito.identity.provider)
    implementation(libs.cognito.identity)
    implementation(libs.secretsmanager)
    implementation(libs.aws.sdk.dynamodb)
    implementation(libs.aws.sdk.dynamodb.enhanced)
    implementation(libs.aws.sdk.regions)
    implementation(libs.datafaker)
    implementation(libs.konform)
    implementation(libs.java.jwt)
    implementation(libs.jwks.rsa)
    implementation(libs.gson)

    testImplementation(kotlin("test"))
    testImplementation(libs.ktor.server.tests)
    testImplementation(libs.mockk)

    // AWS Lambdas
    implementation(libs.aws.lambda.java.core)
    implementation(libs.aws.lambda.java.events)
    implementation(libs.aws.lambda.java.log4j)

    // DynamoDB
    implementation(libs.aws.sdk.dynamodb)
    implementation(libs.aws.sdk.dynamodb.enhanced)
    implementation(libs.aws.sdk.auth)
    implementation(libs.aws.sdk.regions)

    // Two Factor
    implementation(libs.eatthepath.java.otp)
    implementation(libs.commons.codec)
}
