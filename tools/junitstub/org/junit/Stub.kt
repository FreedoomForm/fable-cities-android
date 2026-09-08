package org.junit
annotation class Test
object Assert {
    @JvmStatic fun assertEquals(expected: Any?, actual: Any?) { if (expected != actual) throw AssertionError("$expected != $actual") }
    @JvmStatic fun assertEquals(message: String?, expected: Any?, actual: Any?) { if (expected != actual) throw AssertionError("$message: $expected != $actual") }
    @JvmStatic fun assertEquals(expected: Long, actual: Long) { if (expected != actual) throw AssertionError("$expected != $actual") }
    @JvmStatic fun assertEquals(message: String?, expected: Long, actual: Long) { if (expected != actual) throw AssertionError("$message: $expected != $actual") }
    @JvmStatic fun assertEquals(expected: Double, actual: Double, delta: Double) { if (kotlin.math.abs(expected - actual) > delta) throw AssertionError("$expected != $actual") }
    @JvmStatic fun assertEquals(message: String?, expected: Double, actual: Double, delta: Double) { if (kotlin.math.abs(expected - actual) > delta) throw AssertionError("$message: $expected != $actual") }
    @JvmStatic fun assertTrue(cond: Boolean) { if (!cond) throw AssertionError() }
    @JvmStatic fun assertTrue(msg: String?, cond: Boolean) { if (!cond) throw AssertionError(msg) }
    @JvmStatic fun assertNotNull(o: Any?) { if (o == null) throw AssertionError() }
}
