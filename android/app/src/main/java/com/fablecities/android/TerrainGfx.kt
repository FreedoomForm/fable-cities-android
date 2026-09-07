package com.fablecities.android

import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.fablecities.android.worldgen.GroundControl
import com.fablecities.android.worldgen.Heightmap
import com.fablecities.android.worldgen.WaterMath
import com.fablecities.android.worldgen.v8Hypot3
import com.fablecities.android.worldgen.jsRound

/**
 * Native terrain-splat + puddle graphics support — the CPU side of the site's
 * terrain/TerrainMaterial.js + effects/PuddleField.js pipeline:
 *
 *  - loadLayerArrays: the site's 8 CC0 PBR layers (terrain/textures.js LAYERS) decoded from the
 *    APK assets into two RGBA byte stacks for GL_TEXTURE_2D_ARRAY (albedo+AO, normal+roughness),
 *    exactly the packing of loadLayerArrays(size = 512) — the phone quality tier.
 *  - bakeControlMaps: the terrain/index.js control bake (controlAt + getSlope + shoreAt +
 *    the 8 m Laplacian curvature) — pinned bit-exact by GroundControlParityTest.
 *  - bakeNormalMap: the terrain/index.js fillNormals world-normal map (one texel per heightmap cell).
 *
 * The splat FRAGMENT shader lives in TerrainShaders.kt (FS_TERRAIN / FS_PUDDLE / FX_NOISE_GLSL).
 */
object TerrainGfx {

    const val CONTROL_RES = 512
    const val LAYER_SIZE = 512

    /** terrain/textures.js LAYERS — index order matters (matches the shader). */
    val LAYERS = listOf(
        "Grass004" to 5.0f,      // 0 grass
        "Grass003" to 5.5f,      // 1 dry grass
        "Ground048" to 4.5f,     // 2 dirt
        "Rock030" to 7.0f,       // 3 rock A
        "Ground033" to 4.0f,     // 4 sand
        "Ground054" to 4.0f,     // 5 wet mud
        "Rock035" to 9.0f,       // 6 rock B
        "forest_floor" to 4.0f,  // 7 forest floor
    )

    private fun decodeLayer(assets: AssetManager, dir: String, file: String): IntArray? {
        val path = "shared/$dir/$file"
        val opts = BitmapFactory.Options().apply { inScaled = false; inPreferredConfig = Bitmap.Config.ARGB_8888 }
        val bmp = try { assets.open(path).use { BitmapFactory.decodeStream(it, null, opts) } } catch (_: Exception) { null }
            ?: return null
        val scaled = if (bmp.width != LAYER_SIZE || bmp.height != LAYER_SIZE)
            Bitmap.createScaledBitmap(bmp, LAYER_SIZE, LAYER_SIZE, true) else bmp
        val px = IntArray(LAYER_SIZE * LAYER_SIZE)
        scaled.getPixels(px, 0, LAYER_SIZE, 0, 0, LAYER_SIZE, LAYER_SIZE)
        if (scaled !== bmp) scaled.recycle()
        bmp.recycle()
        return px
    }

    /** Per-layer mean sRGB colour (textures.js loadLayerArrays avg — the undergrowth ground-tint driver). */
    class LayerArrays(val albedo: ByteArray, val normal: ByteArray, val avg: Array<DoubleArray>)

    /**
     * The two layer arrays, interleaved per layer: albedo RGBA = colour RGB + AO in A,
     * normal RGBA = tangent-normal RGB + roughness in A (loadLayerArrays packing).
     * avg = the same every-32nd-pixel mean the web computes for the undergrowth tint.
     */
    fun loadLayerArrays(assets: AssetManager): LayerArrays {
        val px = LAYER_SIZE * LAYER_SIZE
        val albedo = ByteArray(px * 4 * LAYERS.size)
        val normal = ByteArray(px * 4 * LAYERS.size)
        val avg = Array(LAYERS.size) { doubleArrayOf(0.5, 0.5, 0.5) }
        LAYERS.forEachIndexed { li, layer ->
            val (dir, _) = layer
            val col = decodeLayer(assets, dir, "color.jpg")
                ?: IntArray(px) { 0xFF808080.toInt() }      // fallback flat grey
            val nor = decodeLayer(assets, dir, "normal.jpg")
                ?: IntArray(px) { 0xFF8080FF.toInt() }      // fallback flat normal
            val rou = decodeLayer(assets, dir, "roughness.jpg") ?: IntArray(px) { 0xFF808080.toInt() }
            val ao = decodeLayer(assets, dir, "ao.jpg")     // optional on the web (.catch → 255)
            val off = li * px * 4
            var sr = 0.0; var sg = 0.0; var sb = 0.0; var cnt = 0
            for (i in 0 until px) {
                val c = col[i]; val n = nor[i]; val r = rou[i]
                albedo[off + i * 4] = ((c shr 16) and 0xFF).toByte()      // R (getPixels is 0xAARRGGBB)
                albedo[off + i * 4 + 1] = ((c shr 8) and 0xFF).toByte()
                albedo[off + i * 4 + 2] = (c and 0xFF).toByte()
                albedo[off + i * 4 + 3] = if (ao != null) ((ao[i] shr 16) and 0xFF).toByte() else 255.toByte()
                normal[off + i * 4] = ((n shr 16) and 0xFF).toByte()
                normal[off + i * 4 + 1] = ((n shr 8) and 0xFF).toByte()
                normal[off + i * 4 + 2] = (n and 0xFF).toByte()
                normal[off + i * 4 + 3] = ((r shr 16) and 0xFF).toByte()
                // textures.js: `if ((i & 0x7c) === 0)` — every 32nd pixel of the 4-byte stride stream
                if ((i * 4) and 0x7c == 0) {
                    sr += ((c shr 16) and 0xFF).toDouble(); sg += ((c shr 8) and 0xFF).toDouble(); sb += (c and 0xFF).toDouble(); cnt++
                }
            }
            avg[li] = doubleArrayOf(sr / cnt / 255.0, sg / cnt / 255.0, sb / cnt / 255.0)
        }
        return LayerArrays(albedo, normal, avg)
    }

    /** terrain/index.js curvatureAt — 8 m Laplacian of the heightmap, 0.5 flat. */
    private fun curvatureAt(hm: Heightmap, x: Double, z: Double, h: Double): Double {
        val e = 8.0
        val lap = (hm.getHeight(x + e, z) + hm.getHeight(x - e, z) +
            hm.getHeight(x, z + e) + hm.getHeight(x, z - e) - 4.0 * h) / (e * e)
        return (0.5 - lap * 45.0).coerceIn(0.05, 0.95)
    }

    /** The terrain/index.js shoreAt helper over the signed shore-distance payload. */
    fun shoreAt(hm: Heightmap, shore: ByteArray, x: Double, z: Double): Double {
        val i = jsRound((x + hm.half) / hm.spacing).toInt().coerceIn(0, hm.N - 1)
        val j = jsRound((z + hm.half) / hm.spacing).toInt().coerceIn(0, hm.N - 1)
        return ((shore[j * hm.N + i].toInt() and 0xFF) - 128) * 0.25
    }

    /**
     * The full control bake (terrain/index.js): ctrl RGBA = (dry, dirt, sand, rock)·255,
     * ctrl2 RGBA = (forest, field, 0, curvature)·255, at CONTROL_RES² over the playable map.
     */
    fun bakeControlMaps(hm: Heightmap, seed: Int): Pair<ByteArray, ByteArray> {
        val ground = GroundControl(hm, seed)
        val shore = WaterMath.computeShoreDistance(hm)
        val step = hm.size.toDouble() / CONTROL_RES
        val ctrl = ByteArray(CONTROL_RES * CONTROL_RES * 4)
        val ctrl2 = ByteArray(CONTROL_RES * CONTROL_RES * 4)
        for (j in 0 until CONTROL_RES) {
            val z = -hm.half + (j + 0.5) * step
            for (i in 0 until CONTROL_RES) {
                val x = -hm.half + (i + 0.5) * step
                val k = (j * CONTROL_RES + i) * 4
                val h = hm.getHeight(x, z)
                val slope = hm.getSlope(x, z)
                val c = ground.controlAt(x, z, h, slope, shoreAt(hm, shore, x, z))
                ctrl[k] = (255.0 * c.dry).toInt().toByte()
                ctrl[k + 1] = (255.0 * c.dirt).toInt().toByte()
                ctrl[k + 2] = (255.0 * c.sand).toInt().toByte()
                ctrl[k + 3] = (255.0 * c.rock).toInt().toByte()
                ctrl2[k] = (255.0 * c.forest).toInt().toByte()
                ctrl2[k + 1] = (255.0 * c.field.coerceIn(0.0, 1.0)).toInt().toByte()
                ctrl2[k + 2] = 0
                ctrl2[k + 3] = (255.0 * curvatureAt(hm, x, z, h)).toInt().toByte()
            }
        }
        return Pair(ctrl, ctrl2)
    }

    /** The terrain/index.js fillNormals world-normal map: NRES = N-1 texels, 0.5+0.5·n encoding. */
    fun bakeNormalMap(hm: Heightmap): ByteArray {
        val N = hm.N
        val NRES = N - 1
        val d = hm.data
        val sp = hm.spacing.toDouble()
        val out = ByteArray(NRES * NRES * 4)
        for (j in 0 until NRES) for (i in 0 until NRES) {
            val ia = maxOf(0, i - 1); val ib = minOf(N - 1, i + 2)
            val ja = maxOf(0, j - 1); val jb = minOf(N - 1, j + 2)
            val hl = (d[j * N + ia] + d[(j + 1) * N + ia]) * 0.5
            val hr = (d[j * N + ib] + d[(j + 1) * N + ib]) * 0.5
            val hu = (d[ja * N + i] + d[ja * N + i + 1]) * 0.5
            val hd = (d[jb * N + i] + d[jb * N + i + 1]) * 0.5
            val nx = -(hr - hl) / ((ib - ia) * sp)
            val ny = 1.0
            val nz = -(hd - hu) / ((jb - ja) * sp)
            val l = v8Hypot3(nx, ny, nz)
            val k = (j * NRES + i) * 4
            out[k] = (255.0 * (0.5 + 0.5 * nx / l)).toInt().toByte()
            out[k + 1] = (255.0 * (0.5 + 0.5 * ny / l)).toInt().toByte()
            out[k + 2] = (255.0 * (0.5 + 0.5 * nz / l)).toInt().toByte()
            out[k + 3] = 255.toByte()
        }
        return out
    }
}
