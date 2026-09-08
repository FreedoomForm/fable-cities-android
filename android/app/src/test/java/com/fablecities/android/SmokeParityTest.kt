package com.fablecities.android

import com.fablecities.android.worldgen.Rng
import com.fablecities.android.worldgen.Smoke
import com.fablecities.android.worldgen.SmokeGoldens
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Bit-parity golden tests against the REAL browser SmokeSystem.js (effects/SmokeSystem.js) and
 * sprites.js makeSmokeAtlas: the ring-buffer build (budget thinning, dust rect perimeter spawn,
 * burst clustering, tint/opacity jitter, optical-density plumbing) and the 4x4 cauliflower lobe
 * atlas (blob cluster + threshold erosion + lobe pseudo-normal encoding).
 * Expected values were produced by running the actual web code in Node (tools/probe_smoke.mjs),
 * driving build() with a deterministic emitter list mirroring the effects/index.js rebuild()
 * scan output shapes (recorded industrial stacks, legacy steam, cold chimneys, rect dust).
 */
class SmokeParityTest {

    /** The probe's emitter list — identical shapes, identical order (build() consumes one rng stream). */
    private fun emitters(): List<Smoke.Emitter> = listOf(
        Smoke.Emitter("industrial", -120.5, 26.4, 84.0, scale = 1.2 * (0.80 + 3 * 0.10)),
        Smoke.Emitter("industrial", 40.25, 31.15, -60.5, scale = 1.9 * (0.80 + 4 * 0.10)),
        Smoke.Emitter("steam", 12.0, 46.8, 8.4, scale = 0.34, density = 0.45, opacity = 0.20),
        Smoke.Emitter("chimney", -15.6, 11.2, -42.75, scale = 1.05 + 0.2),
        Smoke.Emitter("chimney", 66.1, 9.8, 30.3, scale = 1.25),
        Smoke.Emitter("dust", 5.0, 4.2, -8.0, scale = 1.2 * 1.2, opacity = 0.6,
            rectW = 20.0, rectD = 16.0, rectYaw = 0.3),
    )

    private fun build(): Smoke.Buffers = Smoke.build(emitters(), Rng(1337 xor 0x3ffec7), 4096)

    private fun sum(arr: FloatArray, n: Int): Double {
        var s = 0.0
        for (i in 0 until n) s += arr[i].toDouble()
        return s
    }

    @Test
    fun countFor_parity() {
        val es = emitters()
        for (k in es.indices) {
            assertEquals("countFor[$k]", SmokeGoldens.kindCounts[k].toLong(), Smoke.countFor(es[k]).toLong())
        }
    }

    @Test
    fun build_count_andSums() {
        val b = build()
        assertEquals("instance count", SmokeGoldens.count.toLong(), b.count.toLong())
        assertEquals("sumOrigin", SmokeGoldens.sumOrigin, sum(b.origin, b.count * 3), 1e-3)
        assertEquals("sumVel", SmokeGoldens.sumVel, sum(b.vel, b.count * 3), 1e-3)
        assertEquals("sumParam", SmokeGoldens.sumParam, sum(b.param, b.count * 4), 1e-3)
        assertEquals("sumStyle", SmokeGoldens.sumStyle, sum(b.style, b.count * 4), 1e-3)
        assertEquals("sumColor", SmokeGoldens.sumColor, sum(b.color, b.count * 4), 1e-3)
        assertEquals("sumKind", SmokeGoldens.sumKind, sum(b.kd, b.count * 2), 1e-3)
    }

    @Test
    fun build_headInstances_bitExact() {
        val b = build()
        for (i in SmokeGoldens.headOrigin.indices) {
            assertEquals("origin[$i]", SmokeGoldens.headOrigin[i].toDouble(), b.origin[i].toDouble(), 1e-6)
        }
        for (i in SmokeGoldens.headParam.indices) {
            assertEquals("param[$i]", SmokeGoldens.headParam[i].toDouble(), b.param[i].toDouble(), 1e-6)
        }
    }

    @Test
    fun atlas_bitParity() {
        val data = Smoke.makeSmokeAtlas(1337, 128, 4, 4)
        var r = 0L; var g = 0L; var bl = 0L; var a = 0L; var total = 0L
        var i = 0
        while (i < data.size) {
            val cr = data[i].toLong() and 0xFF
            val cg = data[i + 1].toLong() and 0xFF
            val cb = data[i + 2].toLong() and 0xFF
            val ca = data[i + 3].toLong() and 0xFF
            r += cr; g += cg; bl += cb; a += ca
            total += cr + cg + cb + ca
            i += 4
        }
        assertEquals("atlas R sum", SmokeGoldens.atlasR.toLong(), r)
        assertEquals("atlas G sum", SmokeGoldens.atlasG.toLong(), g)
        assertEquals("atlas B sum", SmokeGoldens.atlasB.toLong(), bl)
        assertEquals("atlas A sum", SmokeGoldens.atlasA.toLong(), a)
        assertEquals("atlas total", SmokeGoldens.atlasSum.toLong(), total)
        for (k in SmokeGoldens.atlasHead.indices) {
            assertEquals("atlas byte[$k]", SmokeGoldens.atlasHead[k].toByte(), data[k])
        }
    }
}
