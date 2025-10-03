package ar.com.intrale.branding

import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItem
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest
import software.amazon.awssdk.services.dynamodb.model.Update
import java.time.Instant

class DynamoBrandingRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val tableName: String
) : BrandingRepository {

    override fun putDraft(theme: BrandingTheme, allowOverwrite: Boolean) {
        require(theme.isDraft()) { "Solo se pueden persistir borradores mediante putDraft" }
        val item = theme.toItem()
        val requestBuilder = PutItemRequest.builder()
            .tableName(tableName)
            .item(item)
        if (!allowOverwrite) {
            requestBuilder.conditionExpression("attribute_not_exists(#pk)")
            requestBuilder.expressionAttributeNames(mapOf("#pk" to PK))
        }
        dynamoDbClient.putItem(requestBuilder.build())
    }

    override fun getPublishedTheme(businessId: String): BrandingTheme? {
        val marker = fetchMarker(businessId) ?: return null
        val versionAttr = marker[VERSION] ?: return null
        val version = versionAttr.n()?.toInt() ?: return null
        return getTheme(businessId, version)
    }

    override fun getTheme(businessId: String, version: Int): BrandingTheme? {
        val response = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(tableName)
                .key(themeKey(businessId, version))
                .build()
        )
        if (!response.hasItem()) {
            return null
        }
        return response.item().toTheme()
    }

    override fun listDrafts(businessId: String): List<BrandingTheme> {
        val request = QueryRequest.builder()
            .tableName(tableName)
            .keyConditionExpression("#pk = :pk and begins_with(#sk, :prefix)")
            .filterExpression("#status = :draft")
            .expressionAttributeNames(
                mapOf(
                    "#pk" to PK,
                    "#sk" to SK,
                    "#status" to STATUS
                )
            )
            .expressionAttributeValues(
                mapOf(
                    ":pk" to s(businessKey(businessId)),
                    ":prefix" to s(THEME_PREFIX),
                    ":draft" to s(ThemeStatus.DRAFT.name)
                )
            )
            .build()
        val response = dynamoDbClient.query(request)
        if (!response.hasItems()) {
            return emptyList()
        }
        return response.items().mapNotNull { it.toTheme() }
            .sortedBy { it.version }
    }

    override fun publishTheme(businessId: String, version: Int, userId: String, timestamp: Instant) {
        val theme = getTheme(businessId, version)
            ?: throw IllegalArgumentException("No existe la versión $version para $businessId")
        val currentMarker = fetchMarker(businessId)
        val currentVersion = currentMarker?.get(VERSION)?.n()?.toInt()

        val operations = mutableListOf<TransactWriteItem>()
        operations += updateThemeToPublished(businessId, version, userId, timestamp)
        operations += upsertMarker(businessId, version, userId, timestamp, allowDowngrade = false)
        if (currentVersion != null && currentVersion != version) {
            operations += revertThemeToDraft(businessId, currentVersion, timestamp)
        }
        dynamoDbClient.transactWriteItems(
            TransactWriteItemsRequest.builder()
                .transactItems(operations)
                .build()
        )
    }

    override fun rollbackToVersion(businessId: String, targetVersion: Int, userId: String, timestamp: Instant) {
        val targetTheme = getTheme(businessId, targetVersion)
            ?: throw IllegalArgumentException("No existe la versión $targetVersion para $businessId")
        val currentMarker = fetchMarker(businessId)
        val currentVersion = currentMarker?.get(VERSION)?.n()?.toInt()

        val operations = mutableListOf<TransactWriteItem>()
        operations += updateThemeToPublished(businessId, targetVersion, userId, timestamp)
        operations += upsertMarker(businessId, targetVersion, userId, timestamp, allowDowngrade = true)
        if (currentVersion != null && currentVersion != targetVersion) {
            operations += revertThemeToDraft(businessId, currentVersion, timestamp)
        }
        dynamoDbClient.transactWriteItems(
            TransactWriteItemsRequest.builder()
                .transactItems(operations)
                .build()
        )
    }

    private fun fetchMarker(businessId: String): Map<String, AttributeValue>? {
        val response = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(tableName)
                .key(markerKey(businessId))
                .build()
        )
        if (!response.hasItem()) {
            return null
        }
        return response.item()
    }

    private fun updateThemeToPublished(
        businessId: String,
        version: Int,
        userId: String,
        timestamp: Instant
    ): TransactWriteItem {
        val key = themeKey(businessId, version)
        val expressionAttributeNames = mapOf("#status" to STATUS)
        val expressionAttributeValues = mapOf(
            ":published" to s(ThemeStatus.PUBLISHED.name),
            ":draft" to s(ThemeStatus.DRAFT.name),
            ":updatedAt" to s(timestamp.toString()),
            ":publishedAt" to s(timestamp.toString()),
            ":publishedBy" to s(userId)
        )
        val updateExpression = "SET #status = :published, updatedAt = :updatedAt, publishedAt = :publishedAt, publishedBy = :publishedBy"
        val conditionExpression = "attribute_exists($PK) AND (#status = :draft OR #status = :published)"
        return TransactWriteItem.builder()
            .update(
                Update.builder()
                    .tableName(tableName)
                    .key(key)
                    .updateExpression(updateExpression)
                    .conditionExpression(conditionExpression)
                    .expressionAttributeNames(expressionAttributeNames)
                    .expressionAttributeValues(expressionAttributeValues)
                    .build()
            )
            .build()
    }

    private fun upsertMarker(
        businessId: String,
        version: Int,
        userId: String,
        timestamp: Instant,
        allowDowngrade: Boolean
    ): TransactWriteItem {
        val key = markerKey(businessId)
        val expressionAttributeNames = mapOf(
            "#type" to TYPE,
            "#version" to VERSION
        )
        val expressionAttributeValues = mapOf(
            ":type" to s(PUBLISHED_MARKER),
            ":version" to n(version),
            ":updatedAt" to s(timestamp.toString()),
            ":publishedAt" to s(timestamp.toString()),
            ":publishedBy" to s(userId)
        )
        val updateExpression = "SET #type = :type, #version = :version, updatedAt = :updatedAt, publishedAt = :publishedAt, publishedBy = :publishedBy"
        val conditionExpression = if (allowDowngrade) {
            "attribute_not_exists(#version) OR #version >= :version"
        } else {
            "attribute_not_exists(#version) OR #version <= :version"
        }
        return TransactWriteItem.builder()
            .update(
                Update.builder()
                    .tableName(tableName)
                    .key(key)
                    .updateExpression(updateExpression)
                    .conditionExpression(conditionExpression)
                    .expressionAttributeNames(expressionAttributeNames)
                    .expressionAttributeValues(expressionAttributeValues)
                    .build()
            )
            .build()
    }

    private fun revertThemeToDraft(
        businessId: String,
        version: Int,
        timestamp: Instant
    ): TransactWriteItem {
        val key = themeKey(businessId, version)
        val expressionAttributeNames = mapOf("#status" to STATUS)
        val expressionAttributeValues = mapOf(
            ":draft" to s(ThemeStatus.DRAFT.name),
            ":updatedAt" to s(timestamp.toString())
        )
        val updateExpression = "SET #status = :draft, updatedAt = :updatedAt REMOVE publishedAt, publishedBy"
        val conditionExpression = "attribute_exists($PK) AND #status = :published"
        val extendedValues = expressionAttributeValues + mapOf(":published" to s(ThemeStatus.PUBLISHED.name))
        return TransactWriteItem.builder()
            .update(
                Update.builder()
                    .tableName(tableName)
                    .key(key)
                    .updateExpression(updateExpression)
                    .conditionExpression(conditionExpression)
                    .expressionAttributeNames(expressionAttributeNames)
                    .expressionAttributeValues(extendedValues)
                    .build()
            )
            .build()
    }

    private fun BrandingTheme.toItem(): Map<String, AttributeValue> {
        val item = mutableMapOf<String, AttributeValue>()
        item[PK] = s(businessKey(businessId))
        item[SK] = s(themeSortKey(version))
        item[TYPE] = s(THEME_TYPE)
        item[STATUS] = s(status.name)
        item[VERSION] = n(version)
        item[UPDATED_AT] = s(updatedAt.toString())
        if (publishedAt != null) {
            item[PUBLISHED_AT] = s(publishedAt.toString())
        }
        if (publishedBy != null) {
            item[PUBLISHED_BY] = s(publishedBy)
        }
        if (metadata.isNotEmpty()) {
            item[METADATA] = AttributeValue.builder().m(
                metadata.mapValues { s(it.value) }
            ).build()
        }
        if (assets.isNotEmpty()) {
            item[ASSETS] = AttributeValue.builder().l(
                assets.map { asset ->
                    AttributeValue.builder().m(
                        buildMap {
                            put(ASSET_ID, s(asset.assetId))
                            put(ASSET_TYPE, s(asset.assetType))
                            put(ASSET_URI, s(asset.uri))
                            if (asset.metadata.isNotEmpty()) {
                                put(
                                    ASSET_METADATA,
                                    AttributeValue.builder().m(asset.metadata.mapValues { s(it.value) }).build()
                                )
                            }
                        }
                    ).build()
                }
            ).build()
        }
        return item
    }

    private fun Map<String, AttributeValue>.toTheme(): BrandingTheme? {
        val pkValue = this[PK]?.s() ?: return null
        val businessId = pkValue.removePrefix("$BUS_PREFIX")
        val skValue = this[SK]?.s() ?: return null
        if (!skValue.startsWith(THEME_PREFIX)) {
            return null
        }
        val version = skValue.removePrefix(THEME_PREFIX).toInt()
        val status = ThemeStatus.from(this[STATUS]?.s() ?: return null)
        val metadataMap = this[METADATA]?.m()?.mapValues { it.value.s() } ?: emptyMap()
        val assetsList = if (this.containsKey(ASSETS)) {
            this[ASSETS]?.l()?.map { value ->
                val assetMap = value.m()
                BrandingAsset(
                    assetId = assetMap[ASSET_ID]?.s() ?: "",
                    assetType = assetMap[ASSET_TYPE]?.s() ?: "",
                    uri = assetMap[ASSET_URI]?.s() ?: "",
                    metadata = assetMap[ASSET_METADATA]?.m()?.mapValues { it.value.s() } ?: emptyMap()
                )
            } ?: emptyList()
        } else {
            emptyList()
        }
        val updatedAt = this[UPDATED_AT]?.s()?.let(Instant::parse) ?: Instant.EPOCH
        val publishedAt = this[PUBLISHED_AT]?.s()?.let(Instant::parse)
        val publishedBy = this[PUBLISHED_BY]?.s()
        return BrandingTheme(
            businessId = businessId,
            version = version,
            status = status,
            metadata = metadataMap,
            assets = assetsList,
            updatedAt = updatedAt,
            publishedAt = publishedAt,
            publishedBy = publishedBy
        )
    }

    companion object {
        private const val PK = "PK"
        private const val SK = "SK"
        private const val TYPE = "type"
        private const val STATUS = "status"
        private const val VERSION = "version"
        private const val UPDATED_AT = "updatedAt"
        private const val PUBLISHED_AT = "publishedAt"
        private const val PUBLISHED_BY = "publishedBy"
        private const val METADATA = "metadata"
        private const val ASSETS = "assets"
        private const val ASSET_ID = "assetId"
        private const val ASSET_TYPE = "assetType"
        private const val ASSET_URI = "uri"
        private const val ASSET_METADATA = "metadata"
        private const val BUS_PREFIX = "BUS#"
        private const val THEME_PREFIX = "THEME#"
        private const val PUBLISHED_MARKER = "PUBLISHED_MARKER"
        private const val THEME_TYPE = "THEME"

        fun businessKey(businessId: String): String = "$BUS_PREFIX$businessId"

        private fun themeSortKey(version: Int): String = "${THEME_PREFIX}${version.toString().padStart(8, '0')}"

        private fun markerKey(businessId: String): Map<String, AttributeValue> = mapOf(
            PK to s(businessKey(businessId)),
            SK to s(PUBLISHED)
        )

        private fun themeKey(businessId: String, version: Int): Map<String, AttributeValue> = mapOf(
            PK to s(businessKey(businessId)),
            SK to s(themeSortKey(version))
        )

        private fun s(value: String): AttributeValue = AttributeValue.builder().s(value).build()

        private fun n(value: Int): AttributeValue = AttributeValue.builder().n(value.toString()).build()

        private const val PUBLISHED = "PUBLISHED"
    }
}
