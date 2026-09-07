package com.fablecities.android

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import com.fablecities.android.worldgen.Rng
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.PI
import kotlin.math.sin

/**
 * Procedural leaf-card textures for the native trees — a faithful STRUCTURAL port of the site's
 * terrain/textures.js `makeBroadleafCardTexture` / `makeConiferCardTexture`: the same seeded
 * silhouette (5 harmonics + 3 deep notches), the same twig skeleton (5 mains × 3 forks), the same
 * leaf-cluster scatter inside the silhouette, and the same warm-brown bark palette. The paint
 * backend is android.graphics.Canvas (the site draws on a browser canvas — antialiasing differs
 * by a pixel, which is invisible at tree scale; the LAYOUT is identical because it comes from the
 * same seeded RNG stream). One 256×256 RGBA texture per palette: oak / birch+maple secondary /
 * spruce / pine.
 */
object LeafTextures {

    class Card(val bitmap: Bitmap)

    /** silhouette radius at angle th — Vegetation.js/textures.js radAt (5 harmonics + 3 notches). */
    private fun makeRadAt(rng: Rng, R: Float): (Double) -> Float {
        val harm = ArrayList<Triple<Int, Double, Double>>() // (k, amp, phase)
        for (k in 0 until 5) {
            harm.add(Triple(k + 2, rng.range(0.05, 0.17) / (k * 0.6 + 1), rng.range(0.0, PI * 2.0)))
        }
        val notches = ArrayList<Triple<Double, Double, Double>>() // (angle, width, depth)
        for (k in 0 until 3) notches.add(Triple(rng.range(0.0, PI * 2.0), rng.range(0.35, 0.7), rng.range(0.22, 0.42)))
        return fun(th: Double): Float {
            var r = 0.80
            for ((k, a, p) in harm) r += a * sin(k * th + p)
            for ((na, nw, nd) in notches) {
                var dd = abs((th - na + PI * 3.0) % (PI * 2.0)) - PI
                dd = abs(dd)
                r -= nd * Math.max(0.0, 1.0 - dd / nw) * Math.max(0.0, 1.0 - dd / nw)
            }
            return (Math.max(0.24, r) * R).toFloat()
        }
    }

    private fun hslColor(h: Double, s: Double, l: Double, alpha: Int = 255): Int {
        // CSS hsl(h deg, s%, l%) → RGB (0..1), standard conversion
        val c = (1.0 - abs(2.0 * l - 1.0)) * s
        val hp = (h % 360.0 + 360.0) % 360.0 / 60.0
        val x = c * (1.0 - abs(hp % 2.0 - 1.0))
        var r = 0.0; var g = 0.0; var b = 0.0
        when {
            hp < 1.0 -> { r = c; g = x }
            hp < 2.0 -> { r = x; g = c }
            hp < 3.0 -> { g = c; b = x }
            hp < 4.0 -> { g = x; b = c }
            hp < 5.0 -> { r = x; b = c }
            else -> { r = c; b = x }
        }
        val m = l - c / 2.0
        fun u(v: Double): Int = ((v + m).coerceIn(0.0, 1.0) * 255.0).toInt()
        return (alpha shl 24) or (u(r) shl 16) or (u(g) shl 8) or u(b)
    }

    /** Broadleaf card: irregular silhouette, twig skeleton, clustered leaf patches. */
    fun broadleaf(size: Int, seed: Int, hueBase: Double, lightBase: Double, sat: Double): Card {
        val rng = Rng(seed)
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        bmp.setPremultiplied(false) // straight-alpha: the shader alpha-tests the raw values
        val canvas = Canvas(bmp)
        val cx = size * 0.5f
        val cy = size * 0.52f
        val R = size * 0.455f
        val radAt = makeRadAt(rng, R)

        // trunk strip (visible below the crown, gives street-level depth)
        val trunkW = size * 0.035f
        val trunkPaint = Paint().apply { color = hslColor(26.0, 0.30, 0.16); isAntiAlias = true }
        canvas.drawRect(cx - trunkW / 2, cy + R * 0.55f, cx + trunkW / 2, size.toFloat(), trunkPaint)

        // twig skeleton: 5 mains fanning up, each with 3 forks (textures.js order)
        val twigPaint = Paint().apply { color = hslColor(28.0, 0.26, 0.15); isAntiAlias = true; strokeCap = Paint.Cap.ROUND }
        data class Twig(val x0: Float, val y0: Float, val x1: Float, val y1: Float, val w: Float, val a: Double)
        val twigs = ArrayList<Twig>()
        val nMain = 5
        for (i in 0 until nMain) {
            val a = -PI * 0.5 + (i.toDouble() / (nMain - 1) - 0.5) * 2.45 + rng.range(-0.16, 0.16)
            val len = radAt(a).toDouble() * rng.range(0.72, 0.98)
            twigs.add(Twig(cx, cy + R * 0.62f, (cx + cos(a) * len).toFloat(), (cy + R * 0.62f + sin(a) * len).toFloat(), 0.0075f, a))
        }
        for (t in twigs.toList()) {
            for (k in 0 until 3) {
                val u = rng.range(0.35, 0.9)
                val bx = t.x0 + (t.x1 - t.x0) * u
                val by = t.y0 + (t.y1 - t.y0) * u
                val a = t.a + (if (rng.next() < 0.5) 1.0 else -1.0) * rng.range(0.35, 0.85)
                val len = R * rng.range(0.14, 0.3)
                twigs.add(Twig(bx.toFloat(), by.toFloat(), (bx + cos(a) * len).toFloat(), (by + sin(a) * len).toFloat(), 0.004f, a))
            }
        }
        for (t in twigs) {
            twigPaint.strokeWidth = size * t.w
            canvas.drawLine(t.x0, t.y0, t.x1, t.y1, twigPaint)
        }

        // leaf clusters inside the silhouette (2 concentric bands, denser at the rim)
        val leaf = Paint().apply { isAntiAlias = true }
        var n = 0
        while (n < 220) {
            val a = rng.range(0.0, PI * 2.0)
            val rr = radAt(a).toDouble() * (0.30 + 0.68 * Math.sqrt(rng.next()))
            val px = (cx + cos(a) * rr).toFloat()
            val py = (cy + R * 0.62f + sin(a) * rr - R * 0.10f).toFloat()

            val hue = hueBase + rng.range(-14.0, 14.0)
            val light = lightBase + rng.range(-0.05, 0.07)
            leaf.color = hslColor(hue, sat, light)
            val rad = (size * rng.range(0.014, 0.035)).toFloat()
            canvas.drawCircle(px, py, rad, leaf)
            n++
        }
        return Card(bmp)
    }

    /** Conifer card: drooping bough tiers of needle strokes over a taller trunk. */
    fun conifer(size: Int, seed: Int, hueBase: Double, sat: Double): Card {
        val rng = Rng(seed)
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        bmp.setPremultiplied(false) // straight-alpha: the shader alpha-tests the raw values
        val canvas = Canvas(bmp)
        val cx = size * 0.5f

        // trunk
        val trunkPaint = Paint().apply { color = hslColor(24.0, 0.28, 0.15); isAntiAlias = true }
        canvas.drawRect(cx - size * 0.022f, size * 0.12f, cx + size * 0.022f, size.toFloat(), trunkPaint)

        // 8 tiers of drooping needle boughs, wider at the bottom (Vegetation.js conifer tiers)
        val bough = Paint().apply { isAntiAlias = true; strokeCap = Paint.Cap.ROUND }
        var tier = 0
        while (tier < 8) {
            val ty = (size * (0.18 + 0.80 * (tier.toDouble() / 7.0))).toFloat()
            val half = (size * (0.10 + 0.34 * (1.0 - tier / 7.0)) * rng.range(0.85, 1.1)).toFloat()
            val drop = (half * rng.range(0.18, 0.38)).toFloat()
            for (side in intArrayOf(-1, 1)) {
                // one bough: 5-8 needle strokes fanning down
                var k = 0
                val nStrokes = 6
                while (k < nStrokes) {
                    val tex = (k + 0.5) / nStrokes
                    val ex = (cx + side * half * (0.55 + 0.45 * tex)).toFloat()
                    val ey = (ty + drop * (0.35 + 0.65 * tex) + rng.range(-0.04, 0.04) * size).toFloat()
                    bough.strokeWidth = (size * rng.range(0.010, 0.020)).toFloat()
                    bough.color = hslColor(hueBase + rng.range(-10.0, 10.0), sat, rng.range(0.14, 0.26))
                    canvas.drawLine((cx + side * size * 0.02f), ty, ex, ey, bough)
                    k++
                }
            }
            tier++
        }
        return Card(bmp)
    }

    /** The five palettes the kinds table maps to (oak / maple / birch / spruce / pine). */
    fun allPalettes(size: Int = 256, seed: Int = 1337): List<Card> = listOf(
        broadleaf(size, seed * 1 + 0, 96.0, 0.26, 0.33),   // oak (hash2(seed,1) domain)
        broadleaf(size, seed * 1 + 5, 112.0, 0.23, 0.36),  // maple
        broadleaf(size, seed * 1 + 2, 79.0, 0.30, 0.30),   // birch
        conifer(size, seed * 1 + 3, 126.0, 0.19),          // spruce
        conifer(size, seed * 1 + 4, 108.0, 0.22),          // pine
    )
}
