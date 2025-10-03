import java.io.InputStream
import java.net.URL

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
    implementation(libs.kodein.di.framework.ktor.server.jvm)

    testImplementation(libs.ktor.server.test.host)
    testImplementation(libs.mockk)
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

    // DynamoDB
    implementation(libs.aws.sdk.dynamodb)
    implementation(libs.aws.sdk.dynamodb.enhanced)
    implementation(libs.aws.sdk.regions)
    implementation(libs.aws.sdk.auth)

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

val dynamodbLocalDir = layout.buildDirectory.dir("dynamodb-local-libs")
val dynamodbLocalLibDir = dynamodbLocalDir.map { it.dir("DynamoDBLocal_lib") }
val dynamodbLocalArchive = layout.buildDirectory.file("dynamodb-local/dynamodb_local_latest.tar.gz")

val downloadDynamoDbLocal by tasks.registering {
    outputs.file(dynamodbLocalArchive)
    doLast {
        val archiveFile = dynamodbLocalArchive.get().asFile
        if (!archiveFile.exists()) {
            archiveFile.parentFile.mkdirs()
            val url = URL("https://dynamodb-local.s3.amazonaws.com/dynamodb_local_latest.tar.gz")
            url.openStream().use { input: InputStream ->
                archiveFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
        }
    }
}

val prepareDynamoDbLocal by tasks.registering(Sync::class) {
    dependsOn(downloadDynamoDbLocal)
    from(tarTree(resources.gzip(dynamodbLocalArchive)))
    into(dynamodbLocalDir)
    include("DynamoDBLocal.jar")
    include("DynamoDBLocal_lib/**")
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}

tasks.withType<Test>().configureEach {
    dependsOn(prepareDynamoDbLocal)
    systemProperty("sqlite4java.library.path", dynamodbLocalLibDir.get().asFile.absolutePath)
    systemProperty("dynamodbLocalDir", dynamodbLocalDir.get().asFile.absolutePath)
}
