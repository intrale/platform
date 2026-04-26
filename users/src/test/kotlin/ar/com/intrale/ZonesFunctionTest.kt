package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import com.auth0.jwt.interfaces.DecodedJWT
import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.core.pagination.sync.SdkIterable
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional
import software.amazon.awssdk.enhanced.dynamodb.model.QueryEnhancedRequest
import java.util.function.Consumer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

internal class StubZonesTable : DynamoDbTable<DeliveryZoneEntity> {
    val items = mutableListOf<DeliveryZoneEntity>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<DeliveryZoneEntity> =
        TableSchema.fromBean(DeliveryZoneEntity::class.java)

    override fun tableName() = "deliveryzones"
    override fun keyFrom(item: DeliveryZoneEntity): Key =
        Key.builder().partitionValue(item.businessId).sortValue(item.zoneId).build()

    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: DeliveryZoneEntity) {
        items.removeAll { it.businessId == item.businessId && it.zoneId == item.zoneId }
        items.add(item)
    }

    override fun getItem(item: DeliveryZoneEntity): DeliveryZoneEntity? =
        items.find { it.businessId == item.businessId && it.zoneId == item.zoneId }

    override fun getItem(key: Key): DeliveryZoneEntity? {
        val pk = key.partitionKeyValue().s()
        val sk = key.sortKeyValue().get().s()
        return items.find { it.businessId == pk && it.zoneId == sk }
    }

    override fun deleteItem(key: Key): DeliveryZoneEntity? {
        val pk = key.partitionKeyValue().s()
        val sk = key.sortKeyValue().get().s()
        val found = items.find { it.businessId == pk && it.zoneId == sk }
        if (found != null) items.remove(found)
        return found
    }

    override fun scan(): PageIterable<DeliveryZoneEntity> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })

    override fun query(queryConditional: QueryConditional): software.amazon.awssdk.enhanced.dynamodb.model.PageIterable<DeliveryZoneEntity> {
        // El query solo se invoca con keyEqualTo(partitionValue=businessId).
        // Filtramos por todos los items que matcheen ese PK comparando el AttributeValue
        // expuesto via la condicion. Como no tenemos acceso directo, devolvemos
        // todos los items y dejamos que el matching pase por test data.
        return PageIterable.create(SdkIterable { mutableListOf(Page.create(items.toList())).iterator() })
    }

    override fun query(request: QueryEnhancedRequest): PageIterable<DeliveryZoneEntity> =
        query(request.queryConditional())

    override fun query(consumer: Consumer<QueryEnhancedRequest.Builder>): PageIterable<DeliveryZoneEntity> {
        val builder = QueryEnhancedRequest.builder()
        consumer.accept(builder)
        return query(builder.build())
    }
}

internal class StubProfileTableZones : DynamoDbTable<UserBusinessProfile> {
    val items = mutableListOf<UserBusinessProfile>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<UserBusinessProfile> =
        TableSchema.fromBean(UserBusinessProfile::class.java)

    override fun tableName() = "profiles"
    override fun keyFrom(item: UserBusinessProfile): Key =
        Key.builder().partitionValue(item.compositeKey).build()

    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: UserBusinessProfile) { items.add(item) }
    override fun getItem(item: UserBusinessProfile): UserBusinessProfile? =
        items.firstOrNull { it.compositeKey == item.compositeKey }

    override fun scan(): PageIterable<UserBusinessProfile> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
}

private class AcceptAllJwtValidator : JwtValidator {
    override fun validate(token: String): DecodedJWT = mockk(relaxed = true)
}

private class RejectAllJwtValidator : JwtValidator {
    override fun validate(token: String): DecodedJWT = throw IllegalStateException("token invalido")
}

class ZonesFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz", "biz-other")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableZones = StubZonesTable()
    private val tableProfiles = StubProfileTableZones()

    private fun seedAdmin(business: String = "biz", email: String = "admin@biz.com") {
        tableProfiles.items.add(UserBusinessProfile().apply {
            this.email = email
            this.business = business
            this.profile = PROFILE_BUSINESS_ADMIN
            this.state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = email })
        }
    }

    private fun newFunction(
        jwt: JwtValidator = AcceptAllJwtValidator(),
        zoneIdGenerator: () -> String = { "zn_test000001" },
    ) = ZonesFunction(
        config = config,
        logger = logger,
        cognito = cognito,
        tableZones = tableZones,
        tableProfiles = tableProfiles,
        jwtValidator = jwt,
        zoneIdGenerator = zoneIdGenerator,
    )

    private val polygonBody = CreateZoneRequest(
        type = "POLYGON",
        shippingCost = 450.0,
        estimatedTimeMinutes = 35,
        polygon = listOf(
            VertexDto(0.0, 0.0),
            VertexDto(0.0, 1.0),
            VertexDto(1.0, 1.0),
            VertexDto(1.0, 0.0),
        )
    )

    private val circleBody = CreateZoneRequest(
        type = "CIRCLE",
        shippingCost = 200.0,
        estimatedTimeMinutes = 20,
        centerLat = -34.6037,
        centerLng = -58.3816,
        radiusMeters = 1500.0,
    )

    @Test
    fun `POST crea zona de tipo POLYGON correctamente`(): Unit = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(polygonBody)
        )
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ZoneCreatedResponse)
        assertEquals(1, tableZones.items.size)
        val stored = tableZones.items.first()
        assertEquals("biz", stored.businessId)
        assertEquals("POLYGON", stored.type)
        assertNotNull(stored.boundingBoxJson)
        assertNotNull(stored.coordsJson)
    }

    @Test
    fun `POST crea zona de tipo CIRCLE correctamente`(): Unit = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(circleBody)
        )
        assertEquals(HttpStatusCode.OK, response.statusCode)
        val stored = tableZones.items.first()
        assertEquals("CIRCLE", stored.type)
        assertEquals(1500.0, stored.radiusMeters)
        assertNotNull(stored.boundingBoxJson)
    }

    @Test
    fun `POST sin Authorization devuelve UnauthorizedException`() = runBlocking {
        val response = newFunction(jwt = RejectAllJwtValidator()).execute(
            "biz", "zones",
            mapOf("X-Http-Method" to "POST"),
            Gson().toJson(polygonBody)
        )
        assertTrue(response is UnauthorizedException)
        assertEquals(0, tableZones.items.size)
    }

    @Test
    fun `POST cross-tenant devuelve UnauthorizedException`() = runBlocking {
        // Usuario es admin de "biz" pero intenta crear en "biz-other"
        seedAdmin(business = "biz", email = "admin@biz.com")
        val response = newFunction().execute(
            "biz-other", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(polygonBody)
        )
        assertTrue(response is UnauthorizedException)
        assertEquals(0, tableZones.items.size)
    }

    @Test
    fun `POST con poligono de menos de 3 vertices devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val invalid = polygonBody.copy(polygon = listOf(VertexDto(0.0, 0.0), VertexDto(1.0, 1.0)))
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(invalid)
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con poligono auto-intersectante (bowtie) devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val bowtie = polygonBody.copy(
            polygon = listOf(
                VertexDto(0.0, 0.0),
                VertexDto(0.0, 1.0),
                VertexDto(1.0, 0.0),
                VertexDto(1.0, 1.0),
            )
        )
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(bowtie)
        )
        assertTrue(response is RequestValidationException)
        val msg = (response as RequestValidationException).message
        assertTrue(msg.contains("cruzarse") || msg.contains("auto-interse"))
    }

    @Test
    fun `POST con poligono degenerado (puntos colineales) devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val degenerate = polygonBody.copy(
            polygon = listOf(
                VertexDto(0.0, 0.0),
                VertexDto(0.0, 1.0),
                VertexDto(0.0, 2.0),
            )
        )
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(degenerate)
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con shippingCost negativo devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(polygonBody.copy(shippingCost = -1.0))
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con shippingCost mayor al maximo devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(polygonBody.copy(shippingCost = 1_000_000.0))
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con latitud fuera de rango devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val invalid = polygonBody.copy(
            polygon = listOf(
                VertexDto(91.0, 0.0),
                VertexDto(0.0, 1.0),
                VertexDto(1.0, 1.0),
            )
        )
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(invalid)
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con type invalido devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(polygonBody.copy(type = "TRIANGLE"))
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST aplica limite de 50 zonas por negocio`() = runBlocking {
        seedAdmin()
        repeat(50) { idx ->
            tableZones.items.add(DeliveryZoneEntity().apply {
                businessId = "biz"
                zoneId = "zn_seed${idx.toString().padStart(7, '0')}"
                type = "POLYGON"
            })
        }
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(polygonBody)
        )
        assertTrue(response is RequestValidationException)
        val msg = (response as RequestValidationException).message
        assertTrue(msg.contains("50"))
        assertEquals(50, tableZones.items.size)
    }

    @Test
    fun `GET es publico y devuelve la lista de zonas`() = runBlocking {
        tableZones.items.add(DeliveryZoneEntity().apply {
            businessId = "biz"
            zoneId = "zn_a1"
            type = "POLYGON"
            shippingCost = 100.0
            currency = "ARS"
        })
        val response = newFunction(jwt = RejectAllJwtValidator()).execute(
            "biz", "zones",
            mapOf("X-Http-Method" to "GET"),
            ""
        )
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ZonesListResponse)
        assertEquals(1, response.zones.size)
    }

    @Test
    fun `GET con cero zonas devuelve lista vacia (no 404)`() = runBlocking {
        val response = newFunction(jwt = RejectAllJwtValidator()).execute(
            "biz", "zones",
            mapOf("X-Http-Method" to "GET"),
            ""
        )
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ZonesListResponse)
        assertEquals(0, response.zones.size)
    }

    @Test
    fun `DELETE elimina la zona del negocio correctamente`() = runBlocking {
        seedAdmin()
        tableZones.items.add(DeliveryZoneEntity().apply {
            businessId = "biz"
            zoneId = "zn_to_delete"
            type = "POLYGON"
        })
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "DELETE", "X-Zone-Id" to "zn_to_delete"),
            ""
        )
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(tableZones.items.none { it.zoneId == "zn_to_delete" })
    }

    @Test
    fun `DELETE sin X-Zone-Id devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "DELETE"),
            ""
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `GET incluye globalBoundingBox cuando hay zonas`() = runBlocking {
        tableZones.items.add(DeliveryZoneEntity().apply {
            businessId = "biz"
            zoneId = "zn_a"
            type = "POLYGON"
            shippingCost = 100.0
            currency = "ARS"
            boundingBoxJson = Gson().toJson(
                mapOf("minLat" to 0.0, "maxLat" to 1.0, "minLng" to 0.0, "maxLng" to 1.0)
            )
        })
        tableZones.items.add(DeliveryZoneEntity().apply {
            businessId = "biz"
            zoneId = "zn_b"
            type = "POLYGON"
            shippingCost = 200.0
            currency = "ARS"
            boundingBoxJson = Gson().toJson(
                mapOf("minLat" to 2.0, "maxLat" to 3.0, "minLng" to 2.0, "maxLng" to 3.0)
            )
        })
        val response = newFunction(jwt = RejectAllJwtValidator()).execute(
            "biz", "zones",
            mapOf("X-Http-Method" to "GET"),
            ""
        )
        assertTrue(response is ZonesListResponse)
        // El globalBoundingBox debe cubrir desde 0 a 3 en ambas dimensiones
        assertEquals(0.0, response.globalBoundingBox["minLat"])
        assertEquals(3.0, response.globalBoundingBox["maxLat"])
    }

    @Test
    fun `POST con metodo no soportado devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "PATCH"),
            Gson().toJson(polygonBody)
        )
        assertTrue(response is RequestValidationException)
        assertTrue((response as RequestValidationException).message.contains("PATCH"))
    }

    @Test
    fun `POST CIRCLE sin radio devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val invalid = circleBody.copy(radiusMeters = null)
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(invalid)
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST CIRCLE con radio mayor al maximo devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(circleBody.copy(radiusMeters = 500_000.0))
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con name muy largo devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(polygonBody.copy(name = "a".repeat(50)))
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con name con caracteres invalidos devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            Gson().toJson(polygonBody.copy(name = "<script>alert(1)</script>"))
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST sin body devuelve BadRequest`() = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            ""
        )
        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `DELETE de zona inexistente devuelve NotFound`() = runBlocking {
        seedAdmin()
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "DELETE", "X-Zone-Id" to "zn_no_existe"),
            ""
        )
        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `generateZoneId genera IDs con prefijo zn_ y 12 chars base36`() {
        val id = ZonesFunction.generateZoneId()
        assertTrue(id.startsWith("zn_"))
        assertEquals(15, id.length)
        // El cuerpo solo contiene base36
        assertTrue(id.substring(3).all { it.isDigit() || it in 'a'..'z' })
    }

    @Test
    fun `DELETE cross-tenant no elimina la zona del otro negocio`() = runBlocking {
        // Hay una zona del business "biz-other"
        tableZones.items.add(DeliveryZoneEntity().apply {
            businessId = "biz-other"
            zoneId = "zn_target"
            type = "POLYGON"
        })
        // Usuario admin de "biz" intenta borrarla pasando el zoneId.
        seedAdmin(business = "biz", email = "admin@biz.com")
        val response = newFunction().execute(
            "biz", "zones",
            mapOf("Authorization" to "token", "X-Http-Method" to "DELETE", "X-Zone-Id" to "zn_target"),
            ""
        )
        // Debe devolver 404 porque la zona NO pertenece a "biz"
        assertEquals(HttpStatusCode.NotFound, response.statusCode)
        // Y la zona debe seguir existiendo
        assertTrue(tableZones.items.any { it.zoneId == "zn_target" })
    }
}
