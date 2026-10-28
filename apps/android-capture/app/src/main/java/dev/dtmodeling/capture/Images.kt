package dev.dtmodeling.capture

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.util.Half
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.Deflater

/**
 * Raw YUV_420_888 planes copied out of an ARCore camera image. Copying is a few memcpys, so the
 * GL thread can close the Image immediately; conversion and JPEG encoding happen on the writer thread.
 * Pixels stay in sensor orientation (landscape), matching the house-capture photo convention.
 */
class YuvCopy private constructor(
    val width: Int, val height: Int,
    private val y: ByteArray, private val yRow: Int,
    private val u: ByteArray, private val uRow: Int, private val uPix: Int,
    private val v: ByteArray, private val vRow: Int, private val vPix: Int,
) {
    /** NV21 at 1/[factor] resolution (nearest sample); dimensions are rounded down to even. */
    fun toNv21(factor: Int): Triple<ByteArray, Int, Int> {
        val w = (width / factor) and 1.inv()
        val h = (height / factor) and 1.inv()
        val out = ByteArray(w * h * 3 / 2)
        if (factor == 1) {
            for (r in 0 until h) System.arraycopy(y, r * yRow, out, r * w, w)
        } else {
            for (r in 0 until h) {
                val src = r * factor * yRow
                val dst = r * w
                for (c in 0 until w) out[dst + c] = y[src + c * factor]
            }
        }
        var o = w * h
        for (r in 0 until h / 2) {
            val sr = r * factor
            for (c in 0 until w / 2) {
                val sc = c * factor
                out[o++] = v[sr * vRow + sc * vPix]
                out[o++] = u[sr * uRow + sc * uPix]
            }
        }
        return Triple(out, w, h)
    }

    fun toJpeg(factor: Int, quality: Int): Triple<ByteArray, Int, Int> {
        val (nv21, w, h) = toNv21(factor)
        val bytes = ByteArrayOutputStream(w * h / 4)
        YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), quality, bytes)
        return Triple(bytes.toByteArray(), w, h)
    }

    companion object {
        fun of(image: Image): YuvCopy {
            val p = image.planes
            return YuvCopy(
                image.width, image.height,
                p[0].buffer.bytes(), p[0].rowStride,
                p[1].buffer.bytes(), p[1].rowStride, p[1].pixelStride,
                p[2].buffer.bytes(), p[2].rowStride, p[2].pixelStride,
            )
        }

        private fun ByteBuffer.bytes(): ByteArray {
            val b = duplicate()
            b.rewind()
            return ByteArray(b.remaining()).also { b.get(it) }
        }
    }
}

/** Depth in meters (0 = no data) plus optional per-pixel confidence (0–255 from ARCore). */
class DepthCopy(val width: Int, val height: Int, val meters: FloatArray) {
    companion object {
        /** DEPTH16 image from acquireDepthImage16Bits / acquireRawDepthImage16Bits: uint16 millimeters. */
        fun of(image: Image): DepthCopy {
            val plane = image.planes[0]
            val buf = plane.buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
            val w = image.width
            val h = image.height
            val out = FloatArray(w * h)
            for (r in 0 until h) {
                val base = r * plane.rowStride
                for (c in 0 until w) {
                    val mm = buf.getShort(base + c * plane.pixelStride).toInt() and 0xFFFF
                    out[r * w + c] = mm / 1000f
                }
            }
            return DepthCopy(w, h, out)
        }

        fun y8(image: Image): ByteArray {
            val plane = image.planes[0]
            val buf = plane.buffer.duplicate()
            val w = image.width
            val out = ByteArray(w * image.height)
            for (r in 0 until image.height) {
                for (c in 0 until w) out[r * w + c] = buf.get(r * plane.rowStride + c * plane.pixelStride)
            }
            return out
        }
    }
}

object Encode {
    /** Little-endian Float16 meters, raw DEFLATE (Python: zlib.decompress(data, -15)) — the `.f16z` format. */
    fun f16z(meters: FloatArray): ByteArray {
        val bb = ByteBuffer.allocate(meters.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (m in meters) bb.putShort(Half.toHalf(m))
        val deflater = Deflater(6, true)
        deflater.setInput(bb.array())
        deflater.finish()
        val out = ByteArrayOutputStream(meters.size)
        val chunk = ByteArray(16 * 1024)
        while (!deflater.finished()) out.write(chunk, 0, deflater.deflate(chunk))
        deflater.end()
        return out.toByteArray()
    }
}
