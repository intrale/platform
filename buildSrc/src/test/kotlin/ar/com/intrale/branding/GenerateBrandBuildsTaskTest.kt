package ar.com.intrale.branding

import org.gradle.testfixtures.ProjectBuilder
import kotlin.test.Test
import kotlin.test.assertNotNull

class GenerateBrandBuildsTaskTest {
    @Test
    fun `registers task`() {
        val project = ProjectBuilder.builder().build()
        val task = project.tasks.register("generateBrandBuilds", GenerateBrandBuildsTask::class.java)

        assertNotNull(task)
    }
}
