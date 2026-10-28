package dev.dtmodeling.capture

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * Writes one capture session as a house-capture/5-compatible bundle:
 *
 *   manifest.json                  format, device, rooms, diagnostics
 *   photos/photos.json, NNNN.jpg   posed photos (sensor orientation, camera-to-world, intrinsics)
 *   depth/frames.json              ARCore depth: NNNNN.f16z (smoothed), NNNNN-raw.f16z, NNNNN.conf, NNNNN.jpg
 *   rooms/room-N-planes.json       ARCore planes at the end of room N (input for PC wall fitting)
 *
 * rooms/room-N.json (RoomPlan geometry) is not produced on Android; dt-modeling/tools generates it.
 * All file IO runs on one background thread; JSON lists are only touched on that thread.
 */
class SessionWriter(val dir: File, private val device: JSONObject) {
    private val io = Executors.newSingleThreadExecutor()
    val pending = AtomicInteger()

    private val photos = JSONArray()
    private val frames = JSONArray()
    private val rooms = mutableMapOf<Int, JSONObject>()
    private val events = JSONArray()
    private val created = iso(Date())

    private var photoCount = 0
    private var depthCount = 0

    init {
        for (sub in listOf("photos", "depth", "rooms")) File(dir, sub).mkdirs()
        submit { writeAll() }
    }

    fun addPhoto(image: YuvCopy, meta: JSONObject) {
        val name = "photos/%04d.jpg".format(photoCount++)
        submit {
            val (jpeg, w, h) = image.toJpeg(1, 92)
            File(dir, name).writeBytes(jpeg)
            meta.put("file", name).put("width", w).put("height", h)
            photos.put(meta)
            if (photos.length() % 20 == 0) writeJson("photos/photos.json", photos)
        }
    }

    /** [confidence] is ARCore raw-depth confidence (0–255) at depth resolution, or null. */
    fun addDepth(depth: DepthCopy, raw: DepthCopy?, confidence: ByteArray?, rgb: YuvCopy?, rgbFactor: Int, meta: JSONObject) {
        val base = "depth/%05d".format(depthCount++)
        submit {
            File(dir, "$base.f16z").writeBytes(Encode.f16z(depth.meters))
            meta.put("file", "$base.f16z").put("width", depth.width).put("height", depth.height)
            meta.put("confidence", "$base.conf")
            File(dir, "$base.conf").writeBytes(houseConfidence(depth, raw, confidence))
            if (raw != null && raw.width == depth.width && raw.height == depth.height) {
                File(dir, "$base-raw.f16z").writeBytes(Encode.f16z(raw.meters))
                meta.put("rawDepth", "$base-raw.f16z")
            }
            if (rgb != null) {
                val (jpeg, w, h) = rgb.toJpeg(rgbFactor, 85)
                File(dir, "$base.jpg").writeBytes(jpeg)
                meta.put("rgb", "$base.jpg").put("rgbWidth", w).put("rgbHeight", h)
            }
            frames.put(meta)
            if (frames.length() % 50 == 0) writeJson("depth/frames.json", frames)
        }
    }

    fun startRoom(index: Int, id: String, name: String) = submit {
        rooms[index] = JSONObject()
            .put("index", index).put("id", id).put("name", name)
            .put("started", iso(Date()))
            .put("geometry", "rooms/room-$index.json")
            .put("planes", "rooms/room-$index-planes.json")
        writeAll()
    }

    fun finishRoom(index: Int, planes: JSONArray, photoCount: Int, depthCount: Int) = submit {
        writeJson("rooms/room-$index-planes.json", JSONObject().put("room", index).put("planes", planes))
        rooms[index]?.put("finished", iso(Date()))?.put("photos", photoCount)?.put("depthFrames", depthCount)
        writeAll()
    }

    fun event(type: String, detail: String? = null) {
        val e = JSONObject().put("time", iso(Date())).put("type", type)
        if (detail != null) e.put("detail", detail)
        submit { events.put(e) }
    }

    /** Flushes everything, stops the writer and calls [onDone] from a background thread. */
    fun finish(onDone: (File) -> Unit) {
        submit { writeAll() }
        io.shutdown()
        thread(name = "writer-finish") {
            io.awaitTermination(2, TimeUnit.MINUTES)
            onDone(dir)
        }
    }

    private fun submit(block: () -> Unit) {
        pending.incrementAndGet()
        io.execute {
            try {
                block()
            } catch (e: Exception) {
                Log.e(TAG, "write failed", e)
                events.put(JSONObject().put("time", iso(Date())).put("type", "write-error").put("detail", e.toString()))
            } finally {
                pending.decrementAndGet()
            }
        }
    }

    private fun writeAll() {
        writeJson("photos/photos.json", photos)
        writeJson("depth/frames.json", frames)
        val roomList = JSONArray()
        rooms.keys.sorted().forEach { roomList.put(rooms[it]) }
        writeJson("manifest.json", JSONObject()
            .put("format", "house-capture/5")
            .put("variant", "android-arcore/1")
            .put("generator", JSONObject().put("app", "dt-capture-android").put("version", BuildConfigInfo.VERSION))
            .put("created", created)
            .put("updated", iso(Date()))
            .put("device", device)
            .put("rooms", roomList)
            .put("files", JSONObject().put("photos", "photos/photos.json").put("depth", "depth/frames.json"))
            .put("alignment", JSONObject().put("method", "first").put("toZone", JSONArray(IDENTITY)))
            .put("roomGeometry", "generated on the PC by dt-modeling/tools (Android has no RoomPlan)")
            .put("diagnostics", JSONObject().put("events", events)))
    }

    private fun writeJson(path: String, value: Any) {
        val target = File(dir, path)
        val tmp = File(dir, "$path.tmp")
        tmp.writeText(if (value is JSONObject) value.toString(1) else (value as JSONArray).toString(1))
        if (!tmp.renameTo(target)) {
            target.delete()
            tmp.renameTo(target)
        }
    }

    companion object {
        private const val TAG = "SessionWriter"
        private val IDENTITY = listOf(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)

        fun iso(d: Date): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(d)

        fun folderName(d: Date): String = SimpleDateFormat("yyyy-MM-dd_HH.mm.ss", Locale.US)
            .apply { timeZone = TimeZone.getDefault() }.format(d)

        /**
         * house-capture confidence is 0–2 (the PC tools keep ≥ 1 by default). ARCore's smoothed depth is
         * dense but its raw depth (where present) carries a real confidence:
         * raw ≥ 170 → 2, raw < 85 → 0, everything else with a smoothed value → 1, no depth → 0.
         */
        private fun houseConfidence(depth: DepthCopy, raw: DepthCopy?, conf: ByteArray?): ByteArray {
            val n = depth.meters.size
            val out = ByteArray(n)
            val usable = raw != null && conf != null && raw.meters.size == n && conf.size == n
            for (i in 0 until n) {
                if (depth.meters[i] <= 0f) continue
                val level = if (usable && raw!!.meters[i] > 0f) {
                    val c = conf!![i].toInt() and 0xFF
                    when {
                        c >= 170 -> 2
                        c < 85 -> 0
                        else -> 1
                    }
                } else 1
                out[i] = level.toByte()
            }
            return out
        }
    }
}

object BuildConfigInfo {
    const val VERSION = "0.1.0"
}
