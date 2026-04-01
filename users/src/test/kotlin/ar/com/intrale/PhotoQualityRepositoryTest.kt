package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhotoQualityRepositoryTest {

    private val repository = PhotoQualityRepository()

    @Test
    fun `save y getByProduct retornan el mismo registro`() {
        val record = PhotoQualityRecord(
            id = "1",
            productId = "prod-1",
            overallScore = 0.8,
            quality = "GOOD",
            issues = emptyList(),
            recommendations = emptyList()
        )

        repository.save("biz", record)
        val retrieved = repository.getByProduct("biz", "prod-1")

        assertNotNull(retrieved)
        assertEquals("prod-1", retrieved.productId)
        assertEquals(0.8, retrieved.overallScore)
        assertEquals("GOOD", retrieved.quality)
    }

    @Test
    fun `getByProduct retorna null si no existe`() {
        val result = repository.getByProduct("biz", "no-existe")
        assertNull(result)
    }

    @Test
    fun `save sobrescribe evaluacion previa del mismo producto`() {
        repository.save("biz", PhotoQualityRecord(
            id = "1", productId = "prod-1", overallScore = 0.3, quality = "BAD"
        ))
        repository.save("biz", PhotoQualityRecord(
            id = "2", productId = "prod-1", overallScore = 0.9, quality = "GOOD"
        ))

        val retrieved = repository.getByProduct("biz", "prod-1")
        assertNotNull(retrieved)
        assertEquals(0.9, retrieved.overallScore)
        assertEquals("GOOD", retrieved.quality)
    }

    @Test
    fun `listByBusiness retorna todas las evaluaciones del negocio`() {
        repository.save("biz", PhotoQualityRecord(id = "1", productId = "p1", overallScore = 0.9, quality = "GOOD"))
        repository.save("biz", PhotoQualityRecord(id = "2", productId = "p2", overallScore = 0.5, quality = "IMPROVABLE"))
        repository.save("otro", PhotoQualityRecord(id = "3", productId = "p3", overallScore = 0.1, quality = "BAD"))

        val results = repository.listByBusiness("biz")
        assertEquals(2, results.size)
    }

    @Test
    fun `listLowQuality retorna solo IMPROVABLE y BAD`() {
        repository.save("biz", PhotoQualityRecord(id = "1", productId = "p1", overallScore = 0.9, quality = "GOOD"))
        repository.save("biz", PhotoQualityRecord(id = "2", productId = "p2", overallScore = 0.5, quality = "IMPROVABLE"))
        repository.save("biz", PhotoQualityRecord(id = "3", productId = "p3", overallScore = 0.2, quality = "BAD"))

        val results = repository.listLowQuality("biz")
        assertEquals(2, results.size)
        assertTrue(results.all { it.quality == "IMPROVABLE" || it.quality == "BAD" })
        // Ordenado por score ascendente
        assertTrue(results.first().overallScore <= results.last().overallScore)
    }

    @Test
    fun `delete elimina la evaluacion`() {
        repository.save("biz", PhotoQualityRecord(id = "1", productId = "prod-1", overallScore = 0.5, quality = "IMPROVABLE"))

        val deleted = repository.delete("biz", "prod-1")
        assertTrue(deleted)
        assertNull(repository.getByProduct("biz", "prod-1"))
    }

    @Test
    fun `delete retorna false si no existe`() {
        val deleted = repository.delete("biz", "no-existe")
        assertEquals(false, deleted)
    }

    @Test
    fun `business key es case-insensitive`() {
        repository.save("BIZ", PhotoQualityRecord(id = "1", productId = "p1", overallScore = 0.8, quality = "GOOD"))

        val result = repository.getByProduct("biz", "p1")
        assertNotNull(result)
    }
}
