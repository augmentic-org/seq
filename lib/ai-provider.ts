// Augmentic fork: AI provider resolution.
// Preferred: direct Google Gemini API with a FREE AI Studio key
// (GOOGLE_GENERATIVE_AI_API_KEY — aistudio.google.com; nano-banana image tier).
// Fallback: Vercel AI Gateway (AI_GATEWAY_API_KEY — paid, also unlocks gpt-image).
import { createGateway } from "@ai-sdk/gateway"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

export type ProviderKind = "local" | "google" | "gateway" | null

// Local Ollama first (free forever, org doctrine), then Google, then gateway.
export function activeProvider(): ProviderKind {
  if (process.env.OLLAMA_BASE_URL) return "local"
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "google"
  if (process.env.AI_GATEWAY_API_KEY) return "gateway"
  return null
}

export const NO_KEY_ERROR =
  "No AI provider configured. Set OLLAMA_BASE_URL (local, free), GOOGLE_GENERATIVE_AI_API_KEY (aistudio.google.com), or AI_GATEWAY_API_KEY in .env.local."

function ollamaProvider() {
  return createOpenAICompatible({
    name: "ollama",
    baseURL: process.env.OLLAMA_BASE_URL!, // e.g. http://mohit-ws:11434/v1
  })
}

function googleProvider() {
  return createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY })
}

export function gatewayProvider() {
  return createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY })
}

// Text + vision model (prompt enhancement, storyboard analysis).
// Pass { vision: true } when the request carries images — the local tier then
// routes to a vision-capable model (gemma3) instead of the text model (qwen).
export function textVisionModel(opts?: { vision?: boolean }) {
  const kind = activeProvider()
  if (kind === "local") {
    const modelId = opts?.vision
      ? process.env.SEQ_LOCAL_VISION_MODEL || "gemma3:12b"
      : process.env.SEQ_LOCAL_TEXT_MODEL || "qwen3-coder:30b"
    return ollamaProvider()(modelId)
  }
  // gemini-3-flash-preview: the current-gen free-tier text/vision model — older
  // 2.5-era ids 404 ("no longer available to new users") on fresh AI Studio keys.
  if (kind === "google") return googleProvider()(process.env.SEQ_GOOGLE_TEXT_MODEL || "gemini-3-flash-preview")
  if (kind === "gateway") return gatewayProvider()("google/gemini-2.5-flash")
  return null
}

// Multimodal image-output model (Gemini-style generateText that returns image files).
// Default direct-Google model is nano banana (gemini-2.5-flash-image) — the free-tier one.
export function geminiImageModel() {
  const kind = activeProvider()
  if (kind === "google") return googleProvider()(process.env.SEQ_GOOGLE_IMAGE_MODEL || "gemini-2.5-flash-image")
  if (kind === "gateway") return gatewayProvider()("google/gemini-3-pro-image")
  return null
}

// ── Cloudflare Workers AI (FREE image tier) ─────────────────────────────────
// flux-1-schnell: ~43 neurons/image against a 10,000 neurons/day free allowance
// (~230 images/day, resets 00:00 UTC, no credit card). Text-to-image only.
// Pattern per bagrounds.org 2026-03-20 — provider priority: cloudflare → google → gateway.

export function cloudflareCreds(): { token: string; accountId: string } | null {
  const token = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  return token && accountId ? { token, accountId } : null
}

export type ImageProviderKind = "cloudflare" | "google" | "gateway" | null

export function imageProvider(): ImageProviderKind {
  if (cloudflareCreds()) return "cloudflare"
  const kind = activeProvider()
  return kind === "local" ? null : kind // local tier has no image generation
}

const CF_IMAGE_MODEL = process.env.SEQ_CF_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell"

// Returns a data URI. flux-schnell outputs square images; aspect ratio is baked
// into the prompt by the caller when it matters.
export async function generateWithCloudflare(prompt: string): Promise<string> {
  const creds = cloudflareCreds()
  if (!creds) throw new Error("Cloudflare credentials not configured")
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${CF_IMAGE_MODEL}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.slice(0, 2048), steps: 8 }),
    },
  )
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Cloudflare Workers AI failed (${res.status}): ${errText.slice(0, 300)}`)
  }
  const data = await res.json()
  const b64 = data?.result?.image
  if (!b64 || typeof b64 !== "string") {
    throw new Error("Cloudflare Workers AI returned no image")
  }
  return `data:image/jpeg;base64,${b64}`
}
