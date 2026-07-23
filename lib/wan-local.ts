// Local Wan 2.2 TI2V-5B video generation via ComfyUI (Augmentic fork addition).
// Talks to a ComfyUI instance (default: SSH-tunneled mohit-ws:8188 → 127.0.0.1:8188)
// running the Wan 2.2 TI2V-5B fp16 checkpoint + umt5 text encoder + wan2.2 VAE.
// Supports text-to-video and image(start frame)-to-video. The 5B TI2V model has
// no first/last-frame conditioning — transition panels fall back to start frame only.

const WAN_LOCAL_URL = process.env.WAN_LOCAL_URL || "http://127.0.0.1:8188"

const NEGATIVE_PROMPT =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"

const FPS = 24
const MAX_LENGTH = 121 // 5s @ 24fps — VRAM/time cap for the 3090 spike

interface WanLocalParams {
  prompt: string
  imageUrl?: string // data URI or https URL for the start frame
  duration?: number // seconds; capped at 5
  aspectRatio?: string
}

function resolveDims(aspectRatio?: string): { width: number; height: number } {
  if (aspectRatio === "9:16") return { width: 704, height: 1280 }
  if (aspectRatio === "1:1") return { width: 960, height: 960 }
  return { width: 1280, height: 704 } // 16:9 default
}

async function uploadStartImage(imageUrl: string): Promise<string> {
  let blob: Blob
  if (imageUrl.startsWith("data:")) {
    const [header, base64] = imageUrl.split(",", 2)
    const mediaType = header.slice(5, header.indexOf(";"))
    blob = new Blob([Buffer.from(base64, "base64")], { type: mediaType })
  } else {
    const res = await fetch(imageUrl)
    if (!res.ok) throw new Error(`Failed to fetch start image: ${res.status}`)
    blob = await res.blob()
  }
  const form = new FormData()
  const ext = blob.type.includes("png") ? "png" : "jpg"
  form.append("image", blob, `seq-start-${Date.now()}.${ext}`)
  form.append("overwrite", "true")
  const res = await fetch(`${WAN_LOCAL_URL}/upload/image`, { method: "POST", body: form })
  if (!res.ok) throw new Error(`ComfyUI image upload failed: ${res.status}`)
  const data = await res.json()
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
}

function buildGraph(params: {
  prompt: string
  width: number
  height: number
  length: number
  startImage?: string
}): Record<string, unknown> {
  const graph: Record<string, any> = {
    "37": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" },
    },
    "38": {
      class_type: "UNETLoader",
      inputs: { unet_name: "wan2.2_ti2v_5B_fp16.safetensors", weight_dtype: "default" },
    },
    "39": { class_type: "VAELoader", inputs: { vae_name: "wan2.2_vae.safetensors" } },
    "48": { class_type: "ModelSamplingSD3", inputs: { shift: 8.0, model: ["38", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: params.prompt, clip: ["37", 0] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: NEGATIVE_PROMPT, clip: ["37", 0] } },
    "55": {
      class_type: "Wan22ImageToVideoLatent",
      inputs: {
        width: params.width,
        height: params.height,
        length: params.length,
        batch_size: 1,
        vae: ["39", 0],
      },
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: Math.floor(Math.random() * 2 ** 32),
        steps: 20,
        cfg: 5,
        sampler_name: "uni_pc",
        scheduler: "simple",
        denoise: 1,
        model: ["48", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["55", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["39", 0] } },
    "60": { class_type: "CreateVideo", inputs: { images: ["8", 0], fps: FPS } },
    "61": {
      class_type: "SaveVideo",
      inputs: { video: ["60", 0], filename_prefix: "video/seq-wan", format: "mp4", codec: "h264" },
    },
  }
  if (params.startImage) {
    graph["56"] = { class_type: "LoadImage", inputs: { image: params.startImage } }
    graph["55"].inputs.start_image = ["56", 0]
  }
  return graph
}

interface HistoryOutputFile {
  filename: string
  subfolder: string
  type: string
}

function findOutputVideo(outputs: Record<string, any>): HistoryOutputFile | null {
  for (const nodeOutput of Object.values(outputs)) {
    for (const files of Object.values(nodeOutput as Record<string, unknown>)) {
      if (!Array.isArray(files)) continue
      for (const f of files) {
        if (f && typeof f.filename === "string" && /\.(mp4|webm|webp)$/i.test(f.filename)) {
          return f as HistoryOutputFile
        }
      }
    }
  }
  return null
}

// Queue the render and return immediately with the ComfyUI prompt id.
// Renders take minutes — browsers kill fetches that stream nothing for ~5min,
// so the client must poll checkWanLocalVideo instead of blocking on the POST.
export async function queueWanLocalVideo(params: WanLocalParams) {
  const { width, height } = resolveDims(params.aspectRatio)
  const length = Math.min(Math.max(Math.round((params.duration || 5) * FPS) + 1, FPS + 1), MAX_LENGTH)

  const startImage = params.imageUrl ? await uploadStartImage(params.imageUrl) : undefined
  const graph = buildGraph({ prompt: params.prompt, width, height, length, startImage })

  const queueRes = await fetch(`${WAN_LOCAL_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: "seq-wan-local" }),
  })
  if (!queueRes.ok) {
    const errText = await queueRes.text()
    throw new Error(`ComfyUI rejected the workflow (${queueRes.status}): ${errText.slice(0, 500)}`)
  }
  const { prompt_id: promptId } = await queueRes.json()
  if (!promptId) throw new Error("ComfyUI returned no prompt_id")

  return { pending: true, requestId: promptId as string, provider: "wan-local" }
}

// One-shot status check for a queued render. Returns the fal-shaped result when
// done, { pending: true } while rendering, or throws on execution error.
export async function checkWanLocalVideo(promptId: string) {
  const histRes = await fetch(`${WAN_LOCAL_URL}/history/${promptId}`)
  if (!histRes.ok) return { pending: true, requestId: promptId }
  const hist = await histRes.json()
  const entry = hist[promptId]
  if (!entry) return { pending: true, requestId: promptId }
  if (entry.status?.status_str === "error") {
    const msgs = JSON.stringify(entry.status?.messages || []).slice(0, 500)
    throw new Error(`ComfyUI execution error: ${msgs}`)
  }
  if (entry.outputs && Object.keys(entry.outputs).length > 0) {
    const video = findOutputVideo(entry.outputs)
    if (video) {
      const q = new URLSearchParams({
        file: video.filename,
        subfolder: video.subfolder || "",
        type: video.type || "output",
      })
      // fal-compatible response shape — the client reads data.video.url
      return {
        data: { video: { url: `/api/seq/generate-video?${q.toString()}` } },
        requestId: promptId,
        provider: "wan-local",
      }
    }
  }
  return { pending: true, requestId: promptId }
}

export async function proxyWanLocalView(file: string, subfolder: string, type: string): Promise<Response> {
  const q = new URLSearchParams({ filename: file, subfolder, type })
  const upstream = await fetch(`${WAN_LOCAL_URL}/view?${q.toString()}`)
  if (!upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: `ComfyUI view failed: ${upstream.status}` }), {
      status: upstream.status || 502,
      headers: { "Content-Type": "application/json" },
    })
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "video/mp4",
      "Cache-Control": "private, max-age=3600",
    },
  })
}
