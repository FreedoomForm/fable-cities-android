package com.fablecities.android

import com.fablecities.android.worldgen.PuddleField
import com.fablecities.android.worldgen.PuddleGoldens
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Bit-parity golden tests against the REAL browser PuddleField.js (effects/PuddleField.js):
 * gutter/rut pool placement on a deterministic synthetic network (FNV-1a segment id XOR seed
 * XOR 0x9d2b → mulberry32), the drainage map raster (R pool / G tyre band / B corridor),
 * pool lift + camber slope from roads.api.surfaceHeight with the terrain fallback, and the
 * merged feathered-disc geometry (positions / per-vertex alpha / indices).
 * Expected values were produced by running the actual web code in Node (tools/probe_puddles.mjs).
 */
class PuddleParityTest {

    /** Mirrors tools/probe_puddles.mjs — pure-arithmetic points, identical doubles in the JVM. */
    private fun network(): List<PuddleField.SegIn> {
        val segs = ArrayList<PuddleField.SegIn>()
        segs.add(PuddleField.SegIn("seg-local-1", "local", 12.0, DoubleArray(62 * 2) { i ->
            val k = i / 2
            if (i % 2 == 0) -300.0 + k * 10.0 else -40.0 + (if (k > 30) 8.0 else 0.0)
        }))
        segs.add(PuddleField.SegIn("seg-avenue-1", "avenue", 24.0, DoubleArray(41 * 2) { i ->
            val k = i / 2
            if (i % 2 == 0) 60.0 + 0.005 * (-200.0 + k * 10.0 + 200.0) else -200.0 + k * 10.0
        }))
        segs.add(PuddleField.SegIn("seg-highway-1", "highway", 32.0, DoubleArray(41 * 2) { i ->
            val k = i / 2
            if (i % 2 == 0) -500.0 + k * 25.0 else -500.0 + k * 18.0
        }))
        segs.add(PuddleField.SegIn("seg-path-1", "path", 3.0, DoubleArray(11 * 2) { i ->
            val k = i / 2
            if (i % 2 == 0) 20.0 + k * 4.0 else 120.0 + k * 2.0
        }))
        segs.add(PuddleField.SegIn("seg-odd-1", "footway", 10.0, DoubleArray(21 * 2) { i ->
            val k = i / 2
            if (i % 2 == 0) -80.0 + k * 8.0 else -120.0 + 0.25 * k
        }))
        return segs
    }

    private fun build(): PuddleField.Result {
        val surfaceHeight: (Double, Double) -> Double? = { x, z ->
            if (x > 250.0) null else 5.5 + 0.002 * x + 0.003 * z  // the probe throws → caught → null
        }
        val terrainH: (Double, Double) -> Double = { x, z -> 3.0 + 0.004 * x - 0.002 * z }
        return PuddleField.build(network(), 1337, surfaceHeight, terrainH)!!
    }

    @Test
    fun pools_andMap_bitParity() {
        val r = build()
        assertEquals("pool count", PuddleGoldens.poolCount.toLong(), r.pools.size.toLong())
        assertEquals("built count", PuddleGoldens.builtCount.toLong(), r.pools.size.toLong())
        assertEquals("segs walked", PuddleGoldens.lastBuildSegs.toLong(), r.lastBuildSegs.toLong())
        assertEquals("map size", PuddleGoldens.mapSize, r.mapSize)
        assertEquals("xf.x", PuddleGoldens.xf[0], r.mapX0, 1e-12)
        assertEquals("xf.y", PuddleGoldens.xf[1], r.mapZ0, 1e-12)
        assertEquals("xf.z", PuddleGoldens.xf[2], 1.0 / r.mapSpan, 1e-12)
        assertEquals("map R", PuddleGoldens.mapR.toLong(), chSum(r.mapData, 0))
        assertEquals("map G", PuddleGoldens.mapG.toLong(), chSum(r.mapData, 1))
        assertEquals("map B", PuddleGoldens.mapB.toLong(), chSum(r.mapData, 2))
        assertEquals("map A", PuddleGoldens.mapA.toLong(), chSum(r.mapData, 3))
        assertEquals("map weighted", PuddleGoldens.mapWeighted.toDouble(), weighted(r.mapData), 0.0)
    }

    @Test
    fun geometry_bitParity() {
        val r = build()
        assertEquals("pos len", PuddleGoldens.posLen, r.verts.size * 3 / 4)
        assertEquals("col len", PuddleGoldens.colLen, r.verts.size)
        assertEquals("idx len", PuddleGoldens.idxLen, r.indices.size)
        assertEquals("idx sum", PuddleGoldens.idxSum.toLong(), idxSum(r.indices))

        // position sum: the web adds its 3-component positions in order — mirror the exact order
        var posSum = 0.0
        for (i in r.verts.indices) if (i % 4 != 3) posSum += r.verts[i].toDouble()
        assertEquals("pos sum", PuddleGoldens.posSum, posSum, 1e-9)

        // colour sum: the web adds rgb(1,1,1) + alpha per vertex — mirror the exact order
        var colSum = 0.0
        var v = 0
        while (v < r.verts.size) {
            colSum += 1.0; colSum += 1.0; colSum += 1.0
            colSum += r.verts[v + 3].toDouble()
            v += 4
        }
        assertEquals("col sum", PuddleGoldens.colSum, colSum, 1e-9)

        // first 136 position components (xyz triples) — goldens come from the web Float32Array
        for (g in PuddleGoldens.discFloats.indices) {
            val expect = PuddleGoldens.discFloats[g]
            val actual = r.verts[4 * (g / 3) + (g % 3)].toDouble()
            assertEquals("pos[$g]", expect, actual, 1e-3)
        }
        // first 136 colour components (rgba quads: 1,1,1,alpha)
        for (g in PuddleGoldens.discAlphas.indices) {
            val expect = PuddleGoldens.discAlphas[g]
            val actual = if (g % 4 == 3) r.verts[4 * (g / 4) + 3].toDouble() else 1.0
            assertEquals("col[$g]", expect, actual, 1e-6)
        }
        // per-disc centres (vertex 0 of each 17-vertex disc)
        for (d in PuddleGoldens.centres.indices) {
            val k = d * 17 * 4
            assertEquals("centre[$d].x", PuddleGoldens.centres[d][0], r.verts[k].toDouble(), 1e-3)
            assertEquals("centre[$d].y", PuddleGoldens.centres[d][1], r.verts[k + 1].toDouble(), 1e-3)
            assertEquals("centre[$d].z", PuddleGoldens.centres[d][2], r.verts[k + 2].toDouble(), 1e-3)
        }
    }

    private fun chSum(a: ByteArray, ch: Int): Long {
        var s = 0L
        var i = ch
        while (i < a.size) { s += a[i].toInt() and 0xFF; i += 4 }
        return s
    }

    private fun weighted(a: ByteArray): Double {
        var s = 0.0
        for (i in a.indices) s += (i % 251 + 1) * (a[i].toInt() and 0xFF)
        return s
    }

    private fun idxSum(a: IntArray): Long {
        var s = 0L
        for (v in a) s = (s + v.toLong()) % 4294967296L
        return s
    }
}
