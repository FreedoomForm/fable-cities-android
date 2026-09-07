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

    // -------------------------------------------------------------------------------------------
    // Undergrowth atlas (textures.js makeUndergrowthAtlas) — 8 cells on a size × size/2 canvas:
    // 0 fine fescue · 1 tall bent-grass with seed heads · 2 dry straw tuft · 3 fern fronds ·
    // 4 low meadow sheet · 5 weeds/clover · 6 wildflower tuft · 7 dry sheet. Same seeded RNG
    // stream, same blade geometry (angle/len/bend/width + 3-stop gradient + quadratic edges),
    // same 6-pass alpha dilation so mipmaps never go transparent at the rims.
    // -------------------------------------------------------------------------------------------

    class Atlas(val bitmap: Bitmap, val cellsAcross: Int = 4, val cellsDown: Int = 2)

    private fun dilateAlpha(bmp: Bitmap, size: Int, height: Int, fr: Int, fg: Int, fb: Int) {
        val px = IntArray(size * height)
        bmp.getPixels(px, 0, size, 0, 0, size, height)
        val mask = ByteArray(size * height)
        for (p in px.indices) mask[p] = if ((px[p] ushr 24) >= 8) 1 else 0
        var cur = mask.copyOf()
        val origMask = mask.copyOf()
        for (pass in 0 until 6) {
            val next = cur.copyOf()
            for (y in 0 until height) for (x in 0 until size) {
                val p = y * size + x
                if (cur[p].toInt() != 0) continue
                var r = 0; var g = 0; var b = 0; var n = 0
                for (dy in -1..1) for (dx in -1..1) {
                    val xx = x + dx; val yy = y + dy
                    if (xx < 0 || yy < 0 || xx >= size || yy >= height) continue
                    val q = yy * size + xx
                    if (cur[q].toInt() == 0) continue
                    val c = px[q]
                    r += (c shr 16) and 0xFF; g += (c shr 8) and 0xFF; b += c and 0xFF; n++
                }
                if (n > 0) {
                    px[p] = (0 shl 24) or ((r / n) shl 16) or ((g / n) shl 8) or (b / n)
                    next[p] = 1
                }
            }
            cur = next
        }
        for (p in px.indices) {
            if (origMask[p].toInt() == 0 && (px[p] ushr 24) < 8) {
                if (cur[p].toInt() == 0) px[p] = (0xFF shl 24) or (fr shl 16) or (fg shl 8) or fb
                px[p] = px[p] and 0x00FFFFFF
            }
        }
        bmp.setPixels(px, 0, size, 0, 0, size, height)
    }

    fun undergrowthAtlas(size: Int = 1024, seed: Int = 21): Atlas {
        val rng = Rng(seed)
        val w = size
        val h = size / 2
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        bmp.setPremultiplied(false)
        val canvas = Canvas(bmp)
        val cell = size / 4f

        fun cellXY(k: Int) = floatArrayOf((k % 4) * cell, (k / 4).toFloat() * cell)

        fun hsl(h0: Double, s: Double, l: Double): Int = hslColor(((h0 % 360.0) + 360.0) % 360.0, s.coerceIn(0.0, 1.0), l.coerceIn(0.0, 1.0))

        // one tapered blade: quadratic both edges from (bx±w, cy) up to the tip, 3-stop vertical gradient
        fun tipXf(ang: Double, bx: Float, bend: Float, len: Float) = bx + cos(ang).toFloat() * len + bend
        fun tipYf(ang: Double, cy: Float, len: Float) = cy + sin(ang).toFloat() * len

        fun blade(g: Canvas, bx: Float, cy: Float, len: Float, bend: Float, w: Float, h0: Double, s: Double, l0: Double, l1: Double, ang: Double) {
            val tipX = tipXf(ang, bx, bend, len)
            val tipY = tipYf(ang, cy, len)
            val midX = bx + cos(ang).toFloat() * len * 0.5f + bend * 0.35f
            val midY = cy + sin(ang).toFloat() * len * 0.5f
            val p = android.graphics.Path()
            p.moveTo(bx - w, cy)
            p.quadTo(midX - w * 0.6f, midY, tipX, tipY)
            p.quadTo(midX + w * 0.6f, midY, bx + w, cy)
            p.close()
            val paint = Paint().apply { isAntiAlias = true; isDither = false }
            paint.shader = android.graphics.LinearGradient(bx, cy, bx, cy - len, intArrayOf(
                hsl(h0 - 6, s, l0), hsl(h0, s + 0.05, (l0 + l1) * 0.5), hsl(h0 + 8, s + 0.08, l1)
            ), null, android.graphics.Shader.TileMode.CLAMP)
            g.drawPath(p, paint)
        }

        fun blades(g: Canvas, k: Int, n: Int, hue: Double, sat: Double, l0: Double, l1: Double, spread: Double, seeds: Boolean, lenMin: Double, lenMax: Double, widthMul: Double) {
            val o = cellXY(k)
            val cx = o[0] + cell * 0.5f
            val cy = o[1] + cell * 0.99f
            for (i in 0 until n) {
                val ang = -PI / 2.0 + rng.range(-spread, spread)
                val len = (cell * rng.range(lenMin, lenMax)).toFloat()
                val bend = (rng.range(-0.5, 0.5) * cell * 0.3).toFloat()
                val wd = (cell * rng.range(0.016, 0.03) * widthMul).toFloat()
                val hh = hue + rng.range(-10.0, 12.0)
                val bx = cx + rng.range(-1.0, 1.0).toFloat() * cell * (if (spread > 1) 0.42f else 0.08f)
                blade(g, bx, cy, len, bend, wd, hh, sat, l0, l1, ang)
                if (seeds && rng.next() < 0.4) {
                    val paint = Paint().apply { color = hsl(hh + 10, 0.3, 0.5); isAntiAlias = true }
                    val save = g.save()
                    val sx = tipXf(ang, bx, bend, len)
                    val sy = tipYf(ang, cy, len)
                    g.rotate(Math.toDegrees(ang + PI / 2.0).toFloat(), sx, sy)
                    g.drawOval(sx - wd * 1.6f, sy - wd * 3.2f, sx + wd * 1.6f, sy + wd * 3.2f, paint)
                    g.restoreToCount(save)
                }
            }
        }

        fun dots(g: Canvas, k: Int, n: Int, colours: List<Int>, yMin: Double, yMax: Double) {
            val o = cellXY(k)
            for (i in 0 until n) {
                val x = o[0] + cell * rng.range(0.12, 0.88).toFloat()
                val y = o[1] + cell * rng.range(yMin, yMax).toFloat()
                val r = (cell * rng.range(0.012, 0.022)).toFloat()
                val pick = colours[kotlin.math.floor(rng.next() * colours.size).toInt().coerceAtMost(colours.size - 1)]
                val paint = Paint().apply { color = pick; isAntiAlias = true }
                g.drawCircle(x, y, r, paint)
                val core = Paint().apply { color = (230 shl 24) or 0xFFF078; isAntiAlias = true }
                g.drawCircle(x, y, r * 0.4f, core)
            }
        }

        // 0: fine fescue — many narrow near-vertical blades, tight spread
        blades(canvas, 0, 46, 96.0, 0.27, 0.15, 0.38, 0.34, false, 0.62, 0.99, 0.62)
        // 1: tall bent-grass — long arching culms with seed heads, wide spread
        blades(canvas, 1, 20, 76.0, 0.24, 0.16, 0.42, 1.15, true, 0.70, 1.0, 0.75)
        // 2: dry straw tuft
        blades(canvas, 2, 30, 52.0, 0.22, 0.17, 0.36, 0.72, true, 0.45, 0.88, 0.85)
        // 3: fern / shrub — 9 arching fronds with paired leaflets
        run {
            val o = cellXY(3)
            val cx = o[0] + cell * 0.5f
            val cy = o[1] + cell * 0.99f
            for (i in 0 until 9) {
                val ang = -PI / 2.0 + rng.range(-1.1, 1.1)
                val len = (cell * rng.range(0.45, 0.85)).toFloat()
                val hue = 108.0 + rng.range(-10.0, 10.0)
                val steps = 14
                var px = cx; var py = cy
                for (s2 in 1..steps) {
                    val t = s2.toDouble() / steps
                    val a = ang + t * t * 0.9 * (if (cos(ang) < 0.0) -1.0 else 1.0)
                    val nx = (px + cos(a) * len / steps).toFloat()
                    val ny = (py + sin(a) * len / steps).toFloat()
                    val stem = Paint().apply { color = hsl(hue - 8, 0.32, 0.2); isAntiAlias = true }
                    stem.strokeWidth = cell * 0.008f * (1.0 - t * 0.6).toFloat()
                    canvas.drawLine(px, py, nx, ny, stem)
                    val ll = (cell * 0.08 * (1.0 - t * 0.7)).toFloat()
                    for (side in intArrayOf(-1, 1)) {
                        val la = a + side * 1.25
                        val leaf = Paint().apply {
                            color = hsl(hue + rng.range(-6.0, 6.0), 0.34, 0.2 + 0.16 * t + rng.range(-0.03, 0.03))
                            isAntiAlias = true
                        }
                        canvas.drawOval(
                            (nx + cos(la).toFloat() * ll * 0.5f - ll * 0.5f), (ny + sin(la).toFloat() * ll * 0.5f - ll * 0.16f),
                            (nx + cos(la).toFloat() * ll * 0.5f + ll * 0.5f), (ny + sin(la).toFloat() * ll * 0.5f + ll * 0.16f), leaf)
                    }
                    px = nx; py = ny
                }
            }
        }
        // 4: low, broad meadow sheet
        blades(canvas, 4, 150, 100.0, 0.24, 0.13, 0.31, 0.60, false, 0.32, 0.70, 0.80)
        // 5: weeds / clover — short blades + round leaflets
        blades(canvas, 5, 44, 104.0, 0.23, 0.15, 0.31, 0.7, false, 0.26, 0.5, 1.0)
        run {
            val o = cellXY(5)
            for (i in 0 until 46) {
                val x = o[0] + cell * rng.range(0.1, 0.9).toFloat()
                val y = o[1] + cell * rng.range(0.62, 0.97).toFloat()
                val r = (cell * rng.range(0.02, 0.036)).toFloat()
                val leaf = Paint().apply { color = hsl(104.0 + rng.range(-8.0, 8.0), 0.3, 0.2 + rng.range(0.0, 0.14)); isAntiAlias = true }
                for (l in 0 until 3) {
                    val a = (l.toDouble() / 3.0) * PI * 2.0 + rng.range(-0.2, 0.2)
                    canvas.drawOval(x + cos(a).toFloat() * r * 0.55f - r * 0.6f, y + sin(a).toFloat() * r * 0.55f - r * 0.42f,
                        x + cos(a).toFloat() * r * 0.55f + r * 0.6f, y + sin(a).toFloat() * r * 0.55f + r * 0.42f, leaf)
                }
            }
        }
        // 6: wildflower tuft + blooms (palette: cream / yellow / pink / white — textures.js dots(6,...))
        blades(canvas, 6, 26, 86.0, 0.25, 0.15, 0.39, 0.70, false, 0.55, 0.95, 0.7)
        dots(canvas, 6, 7, listOf(0xFFCFC9B6.toInt(), 0xFFD2B64A.toInt(), 0xFFB8749A.toInt(), 0xFFD8D4C6.toInt()), 0.12, 0.55)
        // 7: dry sheet
        blades(canvas, 7, 130, 56.0, 0.20, 0.15, 0.33, 0.62, true, 0.32, 0.70, 0.80)
        dilateAlpha(bmp, size, h, 40, 66, 30)
        return Atlas(bmp)
    }
}
