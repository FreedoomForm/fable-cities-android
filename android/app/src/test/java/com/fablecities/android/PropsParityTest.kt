package com.fablecities.android

import com.fablecities.android.worldgen.Props
import com.fablecities.android.worldgen.PropsGoldens
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.hypot
import kotlin.math.max

/**
 * Bit-parity golden test against the REAL browser PropScatter.segment(): synthetic polyline
 * segments (local/avenue/local/path/highway at 260/190/130/90/300 m), the same adapters the
 * renderer builds, seed 1337, density 1.0. Pins the kind counts, the deterministic weighted
 * checksum over all items and the first 40 items at full precision.
 */
class PropsParityTest {

    companion object {
        private val LENGTHS = doubleArrayOf(260.0, 190.0, 130.0, 90.0, 300.0)
        private val TYPES = listOf("local", "avenue", "local", "path", "highway")
        private val HALF = doubleArrayOf(8.0, 11.0, 8.0, 3.5, 15.0)
        private val CW_HALF = doubleArrayOf(3.8, 9.0, 3.8, 1.2, 15.4)
        private val SIDEWALK = doubleArrayOf(2.0, 2.8, 2.0, 0.0, 0.0)

        private val heightFn: (Double, Double) -> Double = { x, z -> 2.0 + 0.01 * x - 0.01 * z }

        fun segments(): List<Props.Seg> {
            val out = ArrayList<Props.Seg>()
            for (i in 0 until 5) {
                val len = LENGTHS[i]
                val n = max(2, Math.round(len / 8.0).toInt())
                val pts = ArrayList<DoubleArray>()
                for (k in 0..n) pts.add(doubleArrayOf(k * (len / n), 0.0))
                out.add(Props.Seg("d$i", TYPES[i], pts, HALF[i], CW_HALF[i], SIDEWALK[i]))
            }
            return out
        }
    }

    @Test
    fun scatter_bitParity() {
        val segs = segments()
        val result = Props.scatterStreet(
            1337, segs, 1.0, heightFn,
            { _, _ -> false },
            { _, _, _ -> false },
        )
        assertEquals("item count", PropsGoldens.itemCount.toLong(), result.items.size.toLong())
        assertEquals("kind count kinds", PropsGoldens.kindCounts.size, result.counts.size)
        for ((k, v) in PropsGoldens.kindCounts) {
            assertEquals("count[$k]", v.toLong(), (result.counts[k] ?: 0).toLong())
        }
        var chk = 0.0
        for ((i, item) in result.items.withIndex()) {
            val tt = item.tint?.let { t -> t[0] * 6.07 + t[1] * 7.01 + t[2] * 8.03 }
                ?: (item.tintHex?.let { h -> h * 9.11 } ?: 0.5)
            // yaw stays out of the checksum (atan2 ulp differs between runtimes); probes pin it
            chk = jsMod(chk + (item.x * 1.37 + item.y * 2.13 + item.z * 3.19 + item.s * 5.01 + tt) * (i % 83 + 1), 4294967296.0)
        }
        assertEquals("item checksum", PropsGoldens.itemChk, chk, 1e-6)
        for (i in PropsGoldens.itemProbes.indices) {
            val item = result.items[i]
            val p = PropsGoldens.itemProbes[i]
            assertEquals("item[$i].kind", p[0], item.kind)
            assertEquals("item[$i].x", p[1] as Double, item.x, 1e-9)
            assertEquals("item[$i].y", p[2] as Double, item.y, 1e-9)
            assertEquals("item[$i].z", p[3] as Double, item.z, 1e-9)
            assertEquals("item[$i].yaw", p[4] as Double, item.yaw, 1e-9)
            assertEquals("item[$i].s", p[5] as Double, item.s, 1e-9)
        }
    }

    private fun jsMod(a: Double, n: Double): Double = a % n
}
