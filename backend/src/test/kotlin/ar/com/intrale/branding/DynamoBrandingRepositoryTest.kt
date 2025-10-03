package ar.com.intrale.branding

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeDefinition
import software.amazon.awssdk.services.dynamodb.model.BillingMode
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.CreateTableRequest
import software.amazon.awssdk.services.dynamodb.model.KeySchemaElement
import software.amazon.awssdk.services.dynamodb.model.KeyType
import software.amazon.awssdk.services.dynamodb.model.ScalarAttributeType
import software.amazon.awssdk.services.dynamodb.waiters.DynamoDbWaiter
import java.io.File
import java.io.IOException
import java.net.ServerSocket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Instant
import java.time.Duration

class DynamoBrandingRepositoryTest {

    private var dynamoProcess: Process? = null
    private lateinit var client: DynamoDbClient
    private lateinit var repository: BrandingRepository

    @BeforeTest
    fun setUp() {
        val port = randomPort()
        startLocalDynamoDb(port)

        client = DynamoDbClient.builder()
            .endpointOverride(URI.create("http://localhost:$port"))
            .region(Region.US_EAST_1)
            .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("dummy", "dummy")))
            .build()

        ensureTable()
        repository = DynamoBrandingRepository(client, TABLE_NAME)
    }

    @AfterTest
    fun tearDown() {
        if (this::client.isInitialized) {
            client.close()
        }
        dynamoProcess?.let { process ->
            process.destroy()
            try {
                if (!process.waitFor(Duration.ofSeconds(5).toMillis(), java.util.concurrent.TimeUnit.MILLISECONDS)) {
                    process.destroyForcibly()
                }
            } catch (_: InterruptedException) {
                process.destroyForcibly()
                Thread.currentThread().interrupt()
            }
        }
        dynamoProcess = null
    }

    @Test
    fun putDraftPersistsTheme() {
        val draft = sampleDraft(version = 1)

        repository.putDraft(draft)

        val stored = repository.getTheme(BUSINESS_ID, 1)
        assertNotNull(stored)
        assertEquals(ThemeStatus.DRAFT, stored.status)
        assertEquals(draft.metadata, stored.metadata)
        assertEquals(draft.assets.first().uri, stored.assets.first().uri)
    }

    @Test
    fun putDraftPreventsOverwriteWhenFlagIsFalse() {
        val draft = sampleDraft(version = 1)
        repository.putDraft(draft)

        assertFailsWith<ConditionalCheckFailedException> {
            repository.putDraft(draft.copy(metadata = mapOf("palette.primary" to "#FFFFFF")))
        }
    }

    @Test
    fun putDraftAllowsOverwriteWhenFlagIsTrue() {
        val draft = sampleDraft(version = 1)
        repository.putDraft(draft)

        val updated = draft.copy(metadata = draft.metadata + ("palette.primary" to "#111111"))
        repository.putDraft(updated, allowOverwrite = true)

        val stored = repository.getTheme(BUSINESS_ID, 1)
        assertNotNull(stored)
        assertEquals("#111111", stored.metadata["palette.primary"])
    }

    @Test
    fun publishThemePromotesDraftAndCreatesMarker() {
        val draftV1 = sampleDraft(version = 1)
        val draftV2 = sampleDraft(version = 2)
        val publishTime = Instant.parse("2024-05-01T10:15:30Z")

        repository.putDraft(draftV1)
        repository.putDraft(draftV2)

        repository.publishTheme(BUSINESS_ID, 1, USER_ID, publishTime)

        val published = repository.getPublishedTheme(BUSINESS_ID)
        assertNotNull(published)
        assertEquals(1, published.version)
        assertEquals(ThemeStatus.PUBLISHED, published.status)
        assertEquals(publishTime, published.publishedAt)
        assertEquals(USER_ID, published.publishedBy)

        val drafts = repository.listDrafts(BUSINESS_ID)
        assertEquals(listOf(2), drafts.map { it.version })
    }

    @Test
    fun publishThemeReplacesPreviousPublishedVersion() {
        val publishTime1 = Instant.parse("2024-05-01T10:15:30Z")
        val publishTime2 = Instant.parse("2024-05-02T08:00:00Z")
        repository.putDraft(sampleDraft(version = 1))
        repository.publishTheme(BUSINESS_ID, 1, USER_ID, publishTime1)
        repository.putDraft(sampleDraft(version = 2))

        repository.publishTheme(BUSINESS_ID, 2, USER_ID, publishTime2)

        val published = repository.getPublishedTheme(BUSINESS_ID)
        assertNotNull(published)
        assertEquals(2, published.version)
        assertEquals(publishTime2, published.publishedAt)

        val previous = repository.getTheme(BUSINESS_ID, 1)
        assertNotNull(previous)
        assertEquals(ThemeStatus.DRAFT, previous.status)
        assertNull(previous.publishedAt)
        assertNull(previous.publishedBy)
    }

    @Test
    fun rollbackToVersionRestoresOlderTheme() {
        val publishTime1 = Instant.parse("2024-05-01T10:15:30Z")
        val publishTime2 = Instant.parse("2024-05-02T08:00:00Z")
        val rollbackTime = Instant.parse("2024-05-03T09:30:00Z")

        repository.putDraft(sampleDraft(version = 1))
        repository.publishTheme(BUSINESS_ID, 1, USER_ID, publishTime1)
        repository.putDraft(sampleDraft(version = 2))
        repository.publishTheme(BUSINESS_ID, 2, USER_ID, publishTime2)

        repository.rollbackToVersion(BUSINESS_ID, 1, USER_ID, rollbackTime)

        val published = repository.getPublishedTheme(BUSINESS_ID)
        assertNotNull(published)
        assertEquals(1, published.version)
        assertEquals(rollbackTime, published.publishedAt)
        assertEquals(USER_ID, published.publishedBy)

        val draft = repository.getTheme(BUSINESS_ID, 2)
        assertNotNull(draft)
        assertEquals(ThemeStatus.DRAFT, draft.status)
        assertNull(draft.publishedAt)
    }

    @Test
    fun listDraftsReturnsSortedVersions() {
        repository.putDraft(sampleDraft(version = 3))
        repository.putDraft(sampleDraft(version = 1))
        repository.putDraft(sampleDraft(version = 2))

        val drafts = repository.listDrafts(BUSINESS_ID)
        assertEquals(listOf(1, 2, 3), drafts.map { it.version })
        assertTrue(drafts.all { it.status == ThemeStatus.DRAFT })
    }

    private fun ensureTable() {
        val tables = client.listTables()
        if (tables.tableNames().contains(TABLE_NAME)) {
            return
        }
        val request = CreateTableRequest.builder()
            .tableName(TABLE_NAME)
            .attributeDefinitions(
                AttributeDefinition.builder().attributeName("PK").attributeType(ScalarAttributeType.S).build(),
                AttributeDefinition.builder().attributeName("SK").attributeType(ScalarAttributeType.S).build()
            )
            .keySchema(
                KeySchemaElement.builder().attributeName("PK").keyType(KeyType.HASH).build(),
                KeySchemaElement.builder().attributeName("SK").keyType(KeyType.RANGE).build()
            )
            .billingMode(BillingMode.PAY_PER_REQUEST)
            .build()
        client.createTable(request)
        val waiter: DynamoDbWaiter = client.waiter()
        waiter.waitUntilTableExists { it.tableName(TABLE_NAME) }
    }

    private fun sampleDraft(version: Int): BrandingTheme = BrandingTheme(
        businessId = BUSINESS_ID,
        version = version,
        status = ThemeStatus.DRAFT,
        metadata = mapOf(
            "palette.primary" to "#3366FF",
            "palette.secondary" to "#00CC99",
            "metadata.version" to version.toString()
        ),
        assets = listOf(
            BrandingAsset(
                assetId = "logo-intrale",
                assetType = "logo",
                uri = "s3://branding-dev/logo-intrale.png"
            )
        ),
        updatedAt = Instant.parse("2024-04-30T00:00:00Z")
    )

    private fun randomPort(): Int = ServerSocket(0).use { it.localPort }

    private fun startLocalDynamoDb(port: Int) {
        val dynamoDirPath = System.getProperty("dynamodbLocalDir")
            ?: error("dynamodbLocalDir system property was not set. Did you run prepareDynamoDbLocal?")
        val dynamoDir = File(dynamoDirPath)
        val dynamoJar = dynamoDir.resolve("DynamoDBLocal.jar")
        val dynamoLibDir = dynamoDir.resolve("DynamoDBLocal_lib")
        require(dynamoJar.exists()) {
            "No se encontró DynamoDBLocal.jar en ${dynamoJar.absolutePath}"
        }
        require(dynamoLibDir.exists()) {
            "No se encontró el directorio DynamoDBLocal_lib en ${dynamoLibDir.absolutePath}"
        }

        val javaBinary = File(System.getProperty("java.home"), "bin/java")
        val classpath = listOf(
            dynamoJar.absolutePath,
            dynamoLibDir.resolve("*").absolutePath
        ).joinToString(File.pathSeparator)
        val command = listOf(
            javaBinary.absolutePath,
            "-Djava.library.path=${dynamoLibDir.absolutePath}",
            "-cp",
            classpath,
            "com.amazonaws.services.dynamodbv2.local.main.ServerRunner",
            "-inMemory",
            "-port",
            port.toString()
        )

        dynamoProcess = ProcessBuilder(command)
            .inheritIO()
            .start()

        waitForServer(port)
    }

    private fun waitForServer(port: Int, timeout: Duration = Duration.ofSeconds(10)) {
        val deadline = System.nanoTime() + timeout.toNanos()
        val client = HttpClient.newHttpClient()
        val request = HttpRequest.newBuilder()
            .uri(URI.create("http://localhost:$port/shell"))
            .timeout(Duration.ofSeconds(1))
            .build()

        while (System.nanoTime() < deadline) {
            try {
                val response = client.send(request, HttpResponse.BodyHandlers.discarding())
                if (response.statusCode() in 200..499) {
                    return
                }
            } catch (_: IOException) {
                // Esperar y reintentar
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                throw IllegalStateException("Interrupted while waiting for DynamoDB Local")
            }
            Thread.sleep(200)
        }
        throw IllegalStateException("DynamoDB Local no inició en el tiempo esperado")
    }

    companion object {
        private const val TABLE_NAME = "branding-test"
        private const val BUSINESS_ID = "intrale"
        private const val USER_ID = "user-123"
    }
}
