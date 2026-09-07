package com.fablecities.android

import com.fablecities.android.worldgen.GroundControl
import com.fablecities.android.worldgen.Heightmap
import com.fablecities.android.worldgen.Vegetation
import com.fablecities.android.worldgen.VegetationGoldens
import com.fablecities.android.worldgen.WaterMath
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Bit-parity golden tests against the REAL browser Vegetation.js placement:
 *  - _distribute (in-map + horizon ring): the forest stands with ragged edges, glades, the
 *    species mix (conifers gain altitude), kind picker, per-tree scale/hue/value jitter —
 *    RNG chain makeRng(hash2(1337, 777)) + cluster noise hash2(1337, 909) + clump seed
 *    hash2(1337, 5151), quality 'high' density 1.0
 *  - canopyCoverage: the crown raster that re-bakes ctrl2.r (the forest-floor splat driver)
 * Expected values were produced by running the actual web class in Node
 * (tools/probe_vegetation.mjs drives the REAL module on a bare prototype instance).
 */
class VegetationParityTest {

    private fun hm1337(): Heightmap = Heightmap(size = 2048, spacing = 4, seed = 1337).generate()

    private fun bake(hm: Heightmap): Triple<ByteArray, ByteArray, ByteArray> {
        val ground = GroundControl(hm, 1337)
        val shore = WaterMath.computeShoreDistance(hm)
        val res = 512
        val step = hm.size.toDouble() / res
        val ctrl = ByteArray(res * res * 4)
        val ctrl2 = ByteArray(res * res * 4)
        for (j in 0 until res) {
            val z = -hm.half + (j + 0.5) * step
            for (i in 0 until res) {
                val x = -hm.half + (i + 0.5) * step
                val k = (j * res + i) * 4
                val h = hm.getHeight(x, z)
                val slope = hm.getSlope(x, z)
                val c = ground.controlAt(x, z, h, slope, VegetationGround.shoreAt(hm, shore, x, z))
                ctrl[k] = (255.0 * c.dry).toInt().toByte()
                ctrl[k + 1] = (255.0 * c.dirt).toInt().toByte()
                ctrl[k + 2] = (255.0 * c.sand).toInt().toByte()
                ctrl[k + 3] = (255.0 * c.rock).toInt().toByte()
                ctrl2[k] = (255.0 * c.forest).toInt().toByte()
                ctrl2[k + 1] = (255.0 * c.field.coerceIn(0.0, 1.0)).toInt().toByte()
                ctrl2[k + 2] = 0
                val e = 8.0
                val lap = (hm.getHeight(x + e, z) + hm.getHeight(x - e, z) +
                    hm.getHeight(x, z + e) + hm.getHeight(x, z - e) - 4.0 * h) / (e * e)
                ctrl2[k + 3] = (255.0 * (0.5 - lap * 45.0).coerceIn(0.05, 0.95)).toInt().toByte()
            }
        }
        return Triple(ctrl, ctrl2, shore)
    }

    @Test
    fun placement_bitParity() {
        val hm = hm1337()
        val (ctrl, ctrl2, shore) = bake(hm)
        val ground = GroundControl(hm, 1337)
        val trees = Vegetation.distribute(
            hm, 1337, 1.0, hm.half,
            { x, z, h, slope -> ground.forestMask(x, z, h, slope) },
            { x, z -> Vegetation.groundInfo(hm, ctrl, ctrl2, 512, shore, x, z) },
        )
        assertEquals("tree count", VegetationGoldens.treeCount.toLong(), trees.size.toLong())
        assertEquals("in-map count", VegetationGoldens.inMapCount.toLong(), trees.count { !it.horizon }.toLong())
        assertEquals("horizon count", VegetationGoldens.horizonCount.toLong(), trees.count { it.horizon }.toLong())
        val kindCount = IntArray(9)
        for (t in trees) kindCount[t.kind]++
        for (k in 0 until 9) assertEquals("kind[$k]", VegetationGoldens.kindCounts[k].toLong(), kindCount[k].toLong())

        // full-precision probes of the first 40 trees
        for (i in VegetationGoldens.treeProbes.indices) {
            val t = trees[i]
            val g = VegetationGoldens.treeProbes[i]
            assertEquals("tree[$i].x", g[0], t.x, 1e-9)
            assertEquals("tree[$i].y", g[1], t.y, 1e-9)
            assertEquals("tree[$i].z", g[2], t.z, 1e-9)
            assertEquals("tree[$i].sxz", g[3], t.sxz, 1e-9)
            assertEquals("tree[$i].sy", g[4], t.sy, 1e-9)
            assertEquals("tree[$i].yaw", g[5], t.yaw, 1e-9)
            assertEquals("tree[$i].kind", g[6].toInt(), t.kind)
            assertEquals("tree[$i].species", g[7].toInt(), t.species)
            assertEquals("tree[$i].horizon", g[8].toInt(), if (t.horizon) 1 else 0)
            assertEquals("tree[$i].r", g[9], t.r, 1e-9)
            assertEquals("tree[$i].g", g[10], t.g, 1e-9)
            assertEquals("tree[$i].b", g[11], t.b, 1e-9)
        }
        // deterministic weighted checksum over ALL trees
        var chk = 0.0
        for (i in trees.indices) {
            val t = trees[i]
            chk = (chk + (t.x * 1.13 + t.y * 2.07 + t.z * 3.11 + t.sxz * 4.07 + t.sy * 5.09 +
                t.yaw * 6.01 + t.r * 7.03 + t.g * 8.01 + t.b * 9.77) * (i % 89 + 1)) % 4294967296.0
        }
        // gaussian() differs by ≤1 ulp between V8 and the JVM on ~0.6 % of draws (log/cos), so
        // the 14920-tree accumulated checksum may drift by ~1e-12 — real bugs move it by thousands
        assertEquals("tree checksum", VegetationGoldens.treeChk.toDouble(), chk, 1e-6)
    }

    @Test
    fun canopy_bitParity() {
        val hm = hm1337()
        val (ctrl, ctrl2, shore) = bake(hm)
        val ground = GroundControl(hm, 1337)
        val trees = Vegetation.distribute(
            hm, 1337, 1.0, hm.half,
            { x, z, h, slope -> ground.forestMask(x, z, h, slope) },
            { x, z -> Vegetation.groundInfo(hm, ctrl, ctrl2, 512, shore, x, z) },
        )
        val canopy = Vegetation.canopyCoverage(trees, hm.half, 512)
        var sum = 0.0
        var weighted = 0.0
        for (i in canopy.indices) { sum += canopy[i]; weighted += canopy[i] * (i % 61 + 1) }
        assertEquals("canopy sum", VegetationGoldens.canopySum, sum, 1e-3)
        assertEquals("canopy weighted", VegetationGoldens.canopyWeighted, weighted, 1e-2)
        for (k in listOf(3, 130, 1000, 4093, 12000, 65536, 131071, 200000, 262143)) {
            assertEquals("canopy[$k]", VegetationGoldens.canopyProbes[listOf(3, 130, 1000, 4093, 12000, 65536, 131071, 200000, 262143).indexOf(k)].toDouble(), canopy[k].toDouble(), 1e-4)
        }
    }
}

/** small shim so the test file stays self-contained */
object VegetationGround {
    fun shoreAt(hm: Heightmap, shore: ByteArray, x: Double, z: Double): Double =
        com.fablecities.android.worldgen.GroundControlShore.shoreAt(hm, shore, x, z)
}
