"use client"

import type React from "react"

import { useState, useRef } from "react"
import { Button } from "@/seq/components/ui/button"
import { Textarea } from "@/seq/components/ui/textarea"
import { Card } from "@/seq/components/ui/card"
import { Loader2, Wand2, Check, RefreshCw, Upload, Pencil, Sparkles } from "lucide-react"
import Image from "next/image"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/seq/components/ui/tabs"
import { Input } from "@/seq/components/ui/input"
import { Label } from "@/seq/components/ui/label"
import { DEMO_STORYBOARD } from "@/seq/lib/demo-data"

interface MasterGeneratorProps {
  onGenerate: (imageUrl: string, prompt: string, panelCount: number) => void
  // Augmentic fork: per-panel generation path — panels arrive already separated,
  // no grid slicing/extraction needed downstream.
  onPanelsGenerated?: (panels: string[], prompt: string) => void
  onLoadDemo?: () => void
}

export function MasterGenerator({ onGenerate, onPanelsGenerated, onLoadDemo }: MasterGeneratorProps) {
  const [prompt, setPrompt] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null)
  const [analyzedCount, setAnalyzedCount] = useState<number | null>(null)
  const [isEditingCount, setIsEditingCount] = useState(false)
  const [mode, setMode] = useState<"generate" | "upload">("generate")
  const [panelCount, setPanelCount] = useState(6)
  const [panelImages, setPanelImages] = useState<string[]>([])
  const [genProgress, setGenProgress] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleLoadDemo = () => {
    setGeneratedUrl(DEMO_STORYBOARD.masterImageUrl)
    setPrompt(DEMO_STORYBOARD.masterDescription)
    setAnalyzedCount(DEMO_STORYBOARD.panelCount)
    setMode("upload")
  }

  // Augmentic fork: generate N separate panel images (plan → per-panel t2i)
  // instead of one grid image. Grid layouts defeat diffusion models (flux) and
  // the old slice/extract step needed a paid Gemini image tier.
  const handleGenerate = async () => {
    if (!prompt.trim()) return

    setIsGenerating(true)
    setGeneratedUrl(null)
    setPanelImages([])
    try {
      // 1. Plan per-panel prompts with the free text model (fallback: naive beats)
      setGenProgress("Planning panels...")
      let style = "cinematic, high-fidelity, consistent characters and lighting across shots"
      let beats: string[] = []
      try {
        const planRes = await fetch("/api/seq/plan-panels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, panelCount }),
        })
        if (planRes.ok) {
          const plan = await planRes.json()
          if (Array.isArray(plan.panels) && plan.panels.length > 0) {
            beats = plan.panels
            if (plan.style) style = plan.style
          }
        }
      } catch {
        /* fall through to naive beats */
      }
      if (beats.length === 0) {
        beats = Array.from(
          { length: panelCount },
          (_, i) => `${prompt} — story moment ${i + 1} of ${panelCount}`,
        )
      }

      // 2. Generate each panel as its own image (sequential — free-tier friendly)
      const generated: string[] = []
      for (let i = 0; i < beats.length; i++) {
        setGenProgress(`Generating panel ${i + 1}/${beats.length}...`)
        const formData = new FormData()
        formData.append("mode", "text-to-image")
        formData.append(
          "prompt",
          `Cinematic storyboard keyframe, purely visual, no text or captions. Style: ${style}. Shot: ${beats[i]}`,
        )
        formData.append("aspectRatio", "16:9")

        const response = await fetch("/api/seq/generate-image", { method: "POST", body: formData })
        if (!response.ok) throw new Error(`Generation failed on panel ${i + 1}`)
        const data = await response.json()
        generated.push(data.url)
        setPanelImages([...generated])
      }

      setGeneratedUrl(generated[0])
      setAnalyzedCount(generated.length)
      setMode("generate")
    } catch (error) {
      console.error("Error:", error)
    } finally {
      setGenProgress(null)
      setIsGenerating(false)
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result as string
      setGeneratedUrl(result)
      if (!prompt) setPrompt(`Uploaded Master: ${file.name}`)

      analyzeImage(result)
    }
    reader.readAsDataURL(file)
  }

  const analyzeImage = async (url: string) => {
    setIsAnalyzing(true)
    setIsEditingCount(false)
    try {
      const response = await fetch("/api/seq/analyze-storyboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: url }),
      })

      if (response.ok) {
        const data = await response.json()
        if (data.panelCount) {
          setAnalyzedCount(data.panelCount)
        }
      }
    } catch (error) {
      console.error("Analysis failed:", error)
      setAnalyzedCount(6)
    } finally {
      setIsAnalyzing(false)
    }
  }

  const handleApprove = () => {
    // Per-panel path: hand the already-separated panels straight downstream
    if (panelImages.length > 0 && onPanelsGenerated) {
      onPanelsGenerated(panelImages, prompt)
      return
    }
    if (generatedUrl) {
      onGenerate(generatedUrl, prompt || "Uploaded Storyboard Master", analyzedCount || 6)
    }
  }

  const handleReset = () => {
    setGeneratedUrl(null)
    setAnalyzedCount(null)
    setPanelImages([])
    if (mode === "upload" && fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div className="text-center space-y-2 mb-8">
        <h2 className="text-section-title tracking-tight">Create Master Storyboard</h2>
        <p className="text-body">Generate a new storyboard or upload an existing master to begin the process.</p>
      </div>

      {!generatedUrl && (
        <div className="flex justify-center mb-4">
          <Button
            variant="outline"
            size="sm"
            onClick={handleLoadDemo}
            className="border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--hover-overlay)] hover:text-[var(--text-primary)] bg-transparent"
          >
            <Sparkles className="mr-2 h-4 w-4" />
            Load Demo (Ratatouille Example)
          </Button>
        </div>
      )}

      <Card className="p-6 bg-[var(--surface-2)] border-[var(--border-default)] space-y-6">
        {!generatedUrl ? (
          <Tabs defaultValue="generate" className="w-full" onValueChange={(v) => setMode(v as any)}>
            <TabsList className="grid w-full grid-cols-2 mb-6 bg-[var(--surface-3)]">
              <TabsTrigger value="generate">Generate New</TabsTrigger>
              <TabsTrigger value="upload">Upload Existing</TabsTrigger>
            </TabsList>

            <TabsContent value="generate" className="space-y-4">
              <div className="space-y-2">
                <Label>Describe your scene</Label>
                <Textarea
                  placeholder="E.g., A sci-fi sequence where a robot discovers a flower in a ruined city. 6 panels showing the approach, discovery, and reaction..."
                  className="min-h-[120px] bg-[var(--surface-3)] border-[var(--border-default)] resize-none text-lg"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>

              <div className="flex items-center gap-3">
                <Label className="whitespace-nowrap">Panels</Label>
                <Input
                  type="number"
                  min={2}
                  max={12}
                  className="w-20 bg-[var(--surface-3)] border-[var(--border-default)]"
                  value={panelCount}
                  onChange={(e) => setPanelCount(Math.min(Math.max(Number.parseInt(e.target.value) || 6, 2), 12))}
                  disabled={isGenerating}
                />
              </div>

              <Button
                onClick={handleGenerate}
                disabled={!prompt.trim() || isGenerating}
                className="w-full h-12 text-lg font-medium bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    {genProgress || "Generating..."}
                  </>
                ) : (
                  <>
                    <Wand2 className="mr-2 h-5 w-5" />
                    Generate Storyboard
                  </>
                )}
              </Button>

              {isGenerating && panelImages.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {panelImages.map((url, i) => (
                    <div
                      key={i}
                      className="relative aspect-video rounded-lg overflow-hidden border border-[var(--border-default)]"
                    >
                      <Image src={url || "/placeholder.svg"} alt={`Panel ${i + 1}`} fill className="object-cover" />
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="upload" className="space-y-6">
              <div
                className="border-2 border-dashed border-[var(--border-emphasis)] rounded-xl p-10 text-center hover:border-[var(--tertiary)] hover:bg-[var(--tertiary-muted)] transition-all cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
              >
                <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileUpload} />
                <div className="flex flex-col items-center gap-2">
                  <div className="p-4 bg-[var(--surface-3)] rounded-full mb-2">
                    <Upload className="h-8 w-8 text-[var(--text-secondary)]" />
                  </div>
                  <h3 className="font-medium text-lg text-[var(--text-primary)]">Click to upload master storyboard</h3>
                  <p className="text-sm text-[var(--text-secondary)]">Supports JPG, PNG, WEBP (rec. 3:2 ratio)</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Optional: Context/Prompt for Upscaling</Label>
                <Input
                  placeholder="Describe the style or content for better upscaling context..."
                  className="bg-[var(--surface-3)] border-[var(--border-default)]"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>
            </TabsContent>
          </Tabs>
        ) : (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {panelImages.length > 0 ? (
              <div className="grid grid-cols-3 gap-2 rounded-xl border border-[var(--border-emphasis)] p-2">
                {panelImages.map((url, i) => (
                  <div
                    key={i}
                    className="relative aspect-video rounded-lg overflow-hidden border border-[var(--border-default)]"
                  >
                    <Image src={url || "/placeholder.svg"} alt={`Panel ${i + 1}`} fill className="object-cover" />
                    <div className="absolute bottom-1 left-1 bg-black/70 px-1.5 py-0.5 rounded text-[10px] text-white">
                      {i + 1}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
            <div className="relative aspect-3/2 rounded-xl overflow-hidden border border-[var(--border-emphasis)]">
              <Image src={generatedUrl || "/placeholder.svg"} alt="Storyboard Master" fill className="object-cover" />
              <div className="absolute top-2 right-2 bg-black/70 px-3 py-1 rounded-lg text-xs font-medium text-white backdrop-blur-sm flex items-center gap-2">
                {isAnalyzing ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Analyzing Layout...
                  </>
                ) : (
                  <>
                    <Check className="w-3 h-3 text-[var(--success)]" />
                    {isEditingCount ? (
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          max={12}
                          className="h-6 w-16 text-xs bg-[var(--surface-3)] border-[var(--border-emphasis)]"
                          value={analyzedCount || 6}
                          onChange={(e) => setAnalyzedCount(Number.parseInt(e.target.value) || 6)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 hover:bg-[var(--hover-overlay)]"
                          onClick={(e) => {
                            e.stopPropagation()
                            setIsEditingCount(false)
                          }}
                        >
                          <Check className="w-3 h-3" />
                        </Button>
                      </div>
                    ) : (
                      <div
                        className="flex items-center gap-2 cursor-pointer hover:text-[var(--text-secondary)]"
                        onClick={() => setIsEditingCount(true)}
                      >
                        <span>{analyzedCount ? `${analyzedCount} Panels Detected` : "Preview Ready"}</span>
                        <Pencil className="w-3 h-3 opacity-50" />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            )}

            <div className="flex gap-4">
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={isGenerating || isAnalyzing}
                className="flex-1 h-12 text-lg border-[var(--border-emphasis)] hover:bg-[var(--hover-overlay)] hover:border-[var(--border-strong)] bg-transparent"
              >
                {mode === "generate" ? (
                  <>
                    <RefreshCw className="mr-2 h-5 w-5" />
                    Generate New
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-5 w-5" />
                    Upload Different
                  </>
                )}
              </Button>

              <Button
                onClick={handleApprove}
                disabled={isAnalyzing}
                className="flex-1 h-12 text-lg bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white"
              >
                <Check className="mr-2 h-5 w-5" />
                Approve & Process
              </Button>
            </div>
            <p className="text-xs text-center text-[var(--text-muted)]">
              {panelImages.length > 0
                ? `${panelImages.length} panels generated individually — approving sends them straight to selection (no slicing needed).`
                : analyzedCount
                  ? `Approving will slice this master into ${analyzedCount} individual panels based on AI analysis.`
                  : "Approving will automatically slice this master into panels and upscale them."}
            </p>
          </div>
        )}
      </Card>
    </div>
  )
}
