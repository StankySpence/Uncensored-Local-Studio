import React, { memo, useEffect, useState } from "react";
import { Crop, Sliders, Cpu, Info, MessageSquare, SlidersHorizontal, Zap } from "lucide-react";
import { stopServer, formatBytes, getLlmStatus } from "../services/api";

const ASPECT_RATIOS = [
  { id: "1:1", label: "1:1 Square", width: 512, height: 512, sdxl_width: 1024, sdxl_height: 1024, desc: "Social posts & avatars" },
  { id: "4:3", label: "4:3 Photo", width: 640, height: 480, sdxl_width: 1152, sdxl_height: 864, desc: "Classic photo look" },
  { id: "16:9", label: "16:9 Landscape", width: 768, height: 432, sdxl_width: 1216, sdxl_height: 684, desc: "Widescreen landscape" },
  { id: "9:16", label: "9:16 Portrait", width: 432, height: 768, sdxl_width: 684, sdxl_height: 1216, desc: "Tall phone screen" }
];

const isSD15OrCustomModel = (modelName) => {
  if (!modelName) return true;
  const name = modelName.toLowerCase();
  if (name.includes("flux") || name.includes("schnell")) return false;
  if (name.includes("sdxl") || name.includes("lightning") || name.includes("turbo")) return false;
  if (name.includes("sd3")) return false;
  return true;
};

function Settings({
  constraints,
  setConstraints,
  activeModel,
  specs,
  backendOptions,
  serverRunning,
  setServerRunning,
  setActiveModel,
  textSettings,
  setTextSettings,
  showAlert = async ({ message }) => window.alert(message),
  showConfirm = async ({ message }) => window.confirm(message),
  health,
  cleanupItems,
  isReadinessBusy,
  refreshReadiness,
  copyDiagnostics,
  cleanupSafeItems,
  diagnosticsCopied,
}) {
  const isSD15OrCustom = activeModel ? isSD15OrCustomModel(activeModel) : false;
  const isOpenVinoNpu = constraints.backendType === "openvino-npu";
  const forceStandardMode = isSD15OrCustom && !isOpenVinoNpu;
  const availableBackends = backendOptions?.options?.length
    ? backendOptions.options
    : [{ id: "cpu", label: "CPU", available: true }];
  const isMac = availableBackends.some(b => b.id === "metal" || b.id === "apple-npu") || 
                (specs?.os_name && (specs.os_name.toLowerCase().includes("darwin") || specs.os_name.toLowerCase().includes("mac")));

  const readinessIssues = [
    ...(health?.stale ? ["Restart Local AI Image Generator so the local server loads the latest API."] : []),
    ...(health?.issues || []),
  ];
  const cleanupBytes = (cleanupItems || []).reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  const showReadinessPanel = Boolean(health && (readinessIssues.length > 0 || (cleanupItems && cleanupItems.length > 0)));

  const [llmStatus, setLlmStatus] = useState({ ready: false, settings: {} });

  useEffect(() => {
    let cancelled = false;
    const fetchLlmStatus = async () => {
      try {
        const status = await getLlmStatus();
        if (!cancelled) setLlmStatus(status);
      } catch (_) {}
    };
    fetchLlmStatus();
    const interval = setInterval(fetchLlmStatus, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const supportsThinking = Boolean(llmStatus.ready && llmStatus.settings?.supportsThinking);

  useEffect(() => {
    if (isOpenVinoNpu && constraints.steps > 8) {
      setConstraints((prev) => ({ ...prev, steps: 8, npuSteps: 8 }));
    }
  }, [constraints.steps, isOpenVinoNpu, setConstraints]);

  const updateConstraint = (key, value) => {
    setConstraints((prev) => ({
      ...prev,
      [key]: value,
      ...(key === "steps"
        ? isOpenVinoNpu
          ? { npuSteps: value }
          : { standardSteps: value }
        : {}),
    }));
  };

  const updateTextSetting = (key, value) => {
    setTextSettings((prev) => ({
      ...prev,
      [key]: value
    }));
  };

  const handleAspectRatioChange = (ratio, sizeType) => {
    if (isOpenVinoNpu && ratio !== "1:1") return;
    const isSDXL = sizeType === "sdxl" && !isSD15OrCustom;
    const selected = ASPECT_RATIOS.find((r) => r.id === ratio);
    if (selected) {
      let w = isSDXL ? selected.sdxl_width : selected.width;
      let h = isSDXL ? selected.sdxl_height : selected.height;
      if (isOpenVinoNpu) {
        const size = constraints.width >= 1024 ? 1024 : 512;
        w = size;
        h = size;
      } else if (isSD15OrCustom) {
        if (w > h) {
          h = Math.round((h * 512) / w);
          w = 512;
        } else {
          w = Math.round((w * 512) / h);
          h = 512;
        }
        w = Math.round(w / 64) * 64;
        h = Math.round(h / 64) * 64;
      }
      updateConstraint("width", w);
      updateConstraint("height", h);
    }
  };

  const handleBackendChange = async (backendType) => {
    const currentBackend = constraints.backendType || "cpu";
    if (backendType === currentBackend) return;

    const switchesAccelerator =
      (currentBackend === "openvino-npu" && backendType !== "openvino-npu") ||
      (currentBackend !== "openvino-npu" && backendType === "openvino-npu");

    if (serverRunning && switchesAccelerator) {
      const leavingNpu = currentBackend === "openvino-npu";
      const confirmed = await showConfirm({
        title: leavingNpu ? "Unload NPU Model?" : "Unload Model?",
        message: leavingNpu
          ? "The OpenVINO NPU model must be unloaded before switching to the standard backend."
          : "The active model must be unloaded before switching to the OpenVINO NPU backend.",
        confirmLabel: "Unload",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!confirmed) return;

      try {
        await stopServer();
        setServerRunning(false);
        setActiveModel(null);
      } catch (err) {
        await showAlert({
          title: "Unload Failed",
          message: err.message || String(err),
          danger: true,
        });
        return;
      }
    }

    setConstraints((prev) => ({
      ...prev,
      backendType,
      useGpu: backendType !== "cpu",
      steps: backendType === "openvino-npu"
        ? Math.max(1, Math.min(8, prev.npuSteps || 4))
        : Math.max(1, Math.min(60, prev.standardSteps || 20)),
      ...(backendType === "openvino-npu"
        ? {
            width: prev.width >= 1024 ? 1024 : 512,
            height: prev.width >= 1024 ? 1024 : 512,
          }
        : {}),
    }));
  };

  return (
    <div className="workspace-area">
      <div className="workspace-title-section">
        <h2 className="workspace-title">Settings & Parameters</h2>
        <p className="workspace-subtitle">
          Configure size, quality, and performance controls for local image and text models.
        </p>
      </div>

      {showReadinessPanel && (
        <div className={`m3-card readiness-card ${health?.stale || readinessIssues.length > 0 ? "readiness-card-warning" : ""}`} style={{ marginBottom: "20px" }}>
          <div className="readiness-header">
            <div>
              <h3 className="m3-card-title" style={{ marginBottom: "4px" }}>
                {health?.stale ? "Restart Required" : readinessIssues.length > 0 ? "System Readiness" : "Safe Cleanup Available"}
              </h3>
              <p className="m3-card-subtitle" style={{ margin: 0 }}>
                {health?.stale
                  ? `Running server build: ${health.build || "unknown"}`
                  : readinessIssues.length > 0
                    ? "Local AI Image Generator found setup items that may need attention."
                    : `${(cleanupItems || []).length} temporary item${(cleanupItems || []).length === 1 ? "" : "s"} can be cleaned (${formatBytes(cleanupBytes)}).`}
              </p>
            </div>
            <div className="readiness-actions">
              <button className="m3-btn m3-btn-outlined" onClick={refreshReadiness} disabled={isReadinessBusy}>
                {isReadinessBusy ? "Checking" : "Refresh"}
              </button>
              <button className="m3-btn m3-btn-tonal" onClick={copyDiagnostics}>
                {diagnosticsCopied ? "Copied" : "Copy Diagnostics"}
              </button>
              {(cleanupItems || []).length > 0 && (
                <button className="m3-btn m3-btn-error" onClick={cleanupSafeItems} disabled={isReadinessBusy}>
                  Clean {formatBytes(cleanupBytes)}
                </button>
              )}
            </div>
          </div>
          {readinessIssues.length > 0 && (
            <div className="readiness-issues">
              {readinessIssues.slice(0, 4).map((issue) => (
                <span key={issue}>{issue}</span>
              ))}
            </div>
          )}
          {(cleanupItems || []).length > 0 && (
            <div className="readiness-cleanup-list">
              {cleanupItems.slice(0, 3).map((item) => (
                <span key={item.id} title={item.path}>
                  {item.name} · {item.size} · {item.reason}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="generator-layout">
        {/* Left Column: Image Settings */}
        <div>
          {/* Card 1: Picture Size & Shape */}
          <div className="m3-card">
            <h3 className="m3-card-title">
              <Crop size={18} style={{ color: "var(--md-sys-color-primary)" }} />
              1. Image Size & Shape
            </h3>
            
            {isOpenVinoNpu ? (
              <div style={{
                background: "rgba(99, 102, 241, 0.1)",
                border: "1px solid var(--md-sys-color-primary)",
                color: "var(--md-sys-color-on-surface)",
                padding: "12px",
                borderRadius: "8px",
                marginBottom: "16px",
                fontSize: "0.85rem",
                display: "flex",
                gap: "8px",
                alignItems: "flex-start"
              }}>
                <Info size={16} style={{ color: "var(--md-sys-color-primary)", flexShrink: 0, marginTop: "2px" }} />
                <div>
                  <strong>OpenVINO NPU Resolution:</strong> The NPU generates at its stable 512x512 resolution. HD mode produces a 1024x1024 output using high-quality Lanczos upscaling without recompiling the model.
                </div>
              </div>
            ) : isSD15OrCustom && (
              <div style={{
                background: "rgba(251, 191, 36, 0.1)",
                border: "1px solid rgb(251, 191, 36)",
                color: "var(--md-sys-color-on-surface)",
                padding: "12px",
                borderRadius: "8px",
                marginBottom: "16px",
                fontSize: "0.85rem",
                display: "flex",
                gap: "8px",
                alignItems: "flex-start"
              }}>
                <Info size={16} style={{ color: "rgb(251, 191, 36)", flexShrink: 0, marginTop: "2px" }} />
                <div>
                  <strong>Graphics Memory Protection Active:</strong> Locked at 512x512 size for this model (<code>{activeModel}</code>). Creating larger images (like 1024x1024) is disabled to prevent your {specs && specs.gpu_name && !specs.gpu_name.includes("Loading") ? specs.gpu_name : "graphics processor"} from running out of memory and crashing.
                </div>
              </div>
            )}

            <div className="m3-field-group">
              {/* Size switcher */}
              <div className="m3-text-field">
                <label className="m3-text-field-label">AI Generation Engine Optimization</label>
                <div className="m3-segmented-button">
                  {forceStandardMode ? (
                    <div
                      className="m3-segment-item disabled"
                      style={{
                        opacity: 0.5,
                        cursor: "not-allowed",
                        textDecoration: "line-through",
                        backgroundColor: "var(--md-sys-color-surface-variant)"
                      }}
                      title="High Quality Mode is disabled for SD 1.x models."
                    >
                      {isOpenVinoNpu ? "HD Upscale (1024px)" : "High Quality Mode (1024px)"}
                    </div>
                  ) : (
                    <div
                      className={`m3-segment-item ${constraints.width >= 1024 ? "active" : ""}`}
                      onClick={() => {
                        updateConstraint("width", 1024);
                        updateConstraint("height", 1024);
                      }}
                    >
                      {isOpenVinoNpu ? "HD Upscale (1024px)" : "High Quality Mode (1024px)"}
                    </div>
                  )}
                  <div
                    className={`m3-segment-item ${constraints.width < 1024 ? "active" : ""}`}
                    onClick={() => {
                      updateConstraint("width", 512);
                      updateConstraint("height", 512);
                    }}
                  >
                    Standard Speed Mode (512px)
                  </div>
                </div>
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "4px" }}>
                  {isOpenVinoNpu
                    ? "*HD mode generates at 512x512 on the NPU, then upscales to 1024x1024. It improves output size, but does not add native diffusion detail."
                    : isSD15OrCustom
                    ? "*Standard Speed Mode (512px) is forced for SD 1.5 / custom models to ensure stable local generations." 
                    : "*Use High Quality (1024px) for Flux or SDXL models. Use Standard (512px) for SD 1.5."}
                </span>
              </div>

              {/* Aspect Ratio Buttons */}
              <div className="m3-text-field">
                <label className="m3-text-field-label">Select Shape (Aspect Ratio)</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                  {ASPECT_RATIOS.map((ratio) => {
                    const isActive = Math.abs((constraints.width / constraints.height) - (ratio.width / ratio.height)) < 0.1;
                    const isUnsupportedOpenVinoShape = isOpenVinoNpu && ratio.id !== "1:1";
                    return (
                      <button
                        key={ratio.id}
                        className={`m3-btn m3-btn-outlined aspect-ratio-btn ${isActive ? "active" : ""}`}
                        disabled={isUnsupportedOpenVinoShape}
                        style={{
                          height: "86px",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: "8px",
                          borderRadius: "var(--md-shape-corner-medium)",
                          borderColor: "var(--md-sys-color-outline-variant)"
                        }}
                        onClick={() => handleAspectRatioChange(ratio.id, forceStandardMode ? "sd15" : (constraints.width >= 1024 ? "sdxl" : "sd15"))}
                      >
                        <div className={`aspect-ratio-preview ratio-${ratio.id.replace(":", "-")}`}></div>
                        <span style={{ fontWeight: 600, fontSize: "0.85rem", marginTop: "2px" }}>{ratio.label}</span>
                        <span style={{ fontSize: "0.68rem", opacity: 0.7 }}>
                          {isUnsupportedOpenVinoShape
                            ? "Not yet supported on NPU"
                            : forceStandardMode
                            ? `Max: ${ratio.id === "1:1" ? "512x512" : ratio.id === "4:3" ? "512x384" : ratio.id === "16:9" ? "512x288" : "288x512"}`
                            : ratio.desc}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: Quality & Logic */}
          <div className="m3-card">
            <h3 className="m3-card-title">
              <Sliders size={18} style={{ color: "var(--md-sys-color-primary)" }} />
              2. Quality, Speed & Logic
            </h3>

            <div className="m3-field-group">
              {/* Quality Steps Slider */}
              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Detail Steps (Inference speed)</span>
                  <span className="m3-slider-value">{constraints.steps} steps</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={constraints.steps}
                  onChange={(e) => updateConstraint("steps", parseInt(e.target.value))}
                  min="1"
                  max={isOpenVinoNpu ? "8" : "60"}
                />
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", lineHeight: "1.3" }}>
                  {isOpenVinoNpu
                    ? "LCM OpenVINO uses 1-8 fast inference steps. Progress is reported after each completed NPU step."
                    : "The number of times the AI cleans up the image. More steps = sharper details, but takes longer."}
                </span>
              </div>

              {/* Random Seed DNA */}
              <div className="m3-text-field" style={{ marginTop: "8px" }}>
                <label className="m3-text-field-label">Image Blueprint (DNA Seed)</label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="number"
                    className="m3-input"
                    value={constraints.seed}
                    onChange={(e) => updateConstraint("seed", parseInt(e.target.value) || -1)}
                    placeholder="-1 for a brand new image..."
                    style={{ flex: 1, height: "40px" }}
                  />
                  <button
                    className="m3-btn m3-btn-tonal"
                    onClick={() => updateConstraint("seed", -1)}
                    style={{ height: "40px" }}
                  >
                    Random (-1)
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Hardware Tier Badge */}
          {specs?.tier && (
            <div className="m3-card" style={{ 
              background: specs.tier === "high" ? "rgba(34, 197, 94, 0.08)" : 
                         specs.tier === "mid" ? "rgba(59, 130, 246, 0.08)" : 
                         "rgba(251, 191, 36, 0.08)",
              border: `1px solid ${specs.tier === "high" ? "rgb(34, 197, 94)" : 
                                      specs.tier === "mid" ? "rgb(59, 130, 246)" : 
                                      "rgb(251, 191, 36)"}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <Cpu size={20} style={{ 
                  color: specs.tier === "high" ? "rgb(34, 197, 94)" : 
                         specs.tier === "mid" ? "rgb(59, 130, 246)" : 
                         "rgb(251, 191, 36)" 
                }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                    {specs.tier === "high" ? "🚀 High-End PC" : 
                     specs.tier === "mid" ? "⚖️ Balanced PC" : 
                     "🥔 Potato PC"}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "2px" }}>
                    {specs.cpu_name} • {specs.cpu_cores_physical} cores • {specs.ram_total_gb}GB RAM
                    {specs.gpu_name && specs.gpu_name !== "Loading..." && ` • ${specs.gpu_name}`}
                    {specs.gpu_vram_gb > 0 && ` • ${specs.gpu_vram_gb}GB VRAM`}
                  </div>
                </div>
              </div>
              {specs.recommended_text_settings && (
                <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px dashed var(--border-color)" }}>
                  <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginBottom: "4px" }}>
                    Recommended text settings:
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    <span style={{ fontSize: "0.7rem", padding: "2px 8px", borderRadius: "4px", background: "var(--md-sys-color-surface-variant)" }}>
                      Ctx: {specs.recommended_text_settings.contextSize}
                    </span>
                    <span style={{ fontSize: "0.7rem", padding: "2px 8px", borderRadius: "4px", background: "var(--md-sys-color-surface-variant)" }}>
                      Threads: {specs.recommended_text_settings.threads}
                    </span>
                    <span style={{ fontSize: "0.7rem", padding: "2px 8px", borderRadius: "4px", background: "var(--md-sys-color-surface-variant)" }}>
                      KV: {specs.recommended_text_settings.cacheTypeK}
                    </span>
                    <span style={{ fontSize: "0.7rem", padding: "2px 8px", borderRadius: "4px", background: "var(--md-sys-color-surface-variant)" }}>
                      Batch: {specs.recommended_text_settings.batchSize}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Card 3: Image Memory Optimizations */}
          <div className="m3-card">
            <h3 className="m3-card-title">
              <SlidersHorizontal size={18} style={{ color: "var(--md-sys-color-primary)" }} />
              3. Image Optimizations
            </h3>
            
            <div className="m3-field-group">
              <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "0.85rem" }}>
                  <input
                    type="checkbox"
                    checked={constraints.vaeTiling !== false}
                    onChange={(e) => updateConstraint("vaeTiling", e.target.checked)}
                    style={{
                      width: "16px",
                      height: "16px",
                      marginTop: "3px",
                      accentColor: "var(--md-sys-color-primary)",
                      cursor: "pointer"
                    }}
                  />
                  <div>
                    <strong style={{ color: "var(--md-sys-color-on-surface)" }}>Enable VAE Tiling</strong>
                    <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "2px", lineHeight: 1.35 }}>
                      Builds the image in smaller, bite-sized sections. This heavily reduces graphics memory usage with no loss in speed. Highly recommended for computers with standard graphics cards.
                    </div>
                  </div>
                </label>

                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "0.85rem" }}>
                  <input
                    type="checkbox"
                    checked={constraints.vaeOnCpu === true}
                    onChange={(e) => updateConstraint("vaeOnCpu", e.target.checked)}
                    style={{
                      width: "16px",
                      height: "16px",
                      marginTop: "3px",
                      accentColor: "var(--md-sys-color-primary)",
                      cursor: "pointer"
                    }}
                  />
                  <div>
                    <strong style={{ color: "var(--md-sys-color-on-surface)" }}>Run VAE on CPU</strong>
                    <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "2px", lineHeight: 1.35 }}>
                      Performs the final image rendering step using your computer's main memory (RAM) instead of graphics memory. Saves graphics memory, but makes the final stage of creating the image slightly slower.
                    </div>
                  </div>
                </label>

                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "0.85rem" }}>
                  <input
                    type="checkbox"
                    checked={constraints.useFlashAttn !== false}
                    onChange={(e) => updateConstraint("useFlashAttn", e.target.checked)}
                    style={{
                      width: "16px",
                      height: "16px",
                      marginTop: "3px",
                      accentColor: "var(--md-sys-color-primary)",
                      cursor: "pointer"
                    }}
                  />
                  <div>
                    <strong style={{ color: "var(--md-sys-color-on-surface)" }}>Enable Flash Attention</strong>
                    <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "2px", lineHeight: 1.35 }}>
                      Accelerates generation using memory-efficient attention. On some specific Mac models or GPUs, this may cause a slight slowdown, so you can disable it if needed.
                    </div>
                  </div>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Text Settings & System */}
        <div>
          {/* Card 4: Text Generation Settings (llama.cpp) */}
          <div className="m3-card">
            <h3 className="m3-card-title">
              <MessageSquare size={18} style={{ color: "var(--md-sys-color-primary)" }} />
              4. Text Generation Settings (GGUF)
            </h3>
            
            <div className="m3-field-group">
              {/* System Prompt instructions */}
              <div className="m3-text-field">
                <label className="m3-text-field-label">Default System Instructions</label>
                <textarea
                  value={textSettings.systemPrompt}
                  onChange={(e) => updateTextSetting("systemPrompt", e.target.value)}
                  placeholder="Set AI instructions (e.g. 'You are a helpful local assistant')..."
                  className="system-prompt"
                  style={{ marginTop: "6px", width: "100%", minHeight: "85px" }}
                />
              </div>

              {/* Context size selector */}
              <div className="m3-text-field" style={{ marginTop: "12px" }}>
                <label className="m3-text-field-label">Context Window Limit</label>
                <select
                  value={textSettings.contextSize}
                  onChange={(e) => updateTextSetting("contextSize", Number(e.target.value))}
                  className="m3-input"
                  style={{ marginTop: "6px", height: "40px", cursor: "pointer" }}
                >
                  <option value="0">Auto-detect (Recommended)</option>
                  <option value="2048">2,048 tokens (Fast/Low Memory)</option>
                  <option value="4096">4,096 tokens (Balanced)</option>
                  <option value="8192">8,192 tokens (More history)</option>
                  <option value="16384">16,384 tokens (Deep context)</option>
                </select>
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "4px" }}>
                  Controls the maximum memory allocated for conversation history. Larger limits allow longer chats but use more RAM/VRAM.
                </span>
              </div>

              {/* Show Thinking Process toggle - only for models that support it */}
              {supportsThinking && (
              <div style={{ marginTop: "16px" }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "0.85rem" }}>
                  <input
                    type="checkbox"
                    checked={textSettings.enableThinking !== false}
                    onChange={(e) => updateTextSetting("enableThinking", e.target.checked)}
                    style={{
                      width: "16px",
                      height: "16px",
                      marginTop: "3px",
                      accentColor: "var(--md-sys-color-primary)",
                      cursor: "pointer"
                    }}
                  />
                  <div>
                    <strong style={{ color: "var(--md-sys-color-on-surface)" }}>Show Thinking Process</strong>
                    <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "2px", lineHeight: 1.35 }}>
                      Enables the collapsible dropdown for models that support reasoning/thinking process (e.g. DeepSeek-R1, Gemma-4-E2B). If turned off, reasoning is hidden and stripped from the conversation view.
                    </div>
                  </div>
                </label>
              </div>
              )}
              {!supportsThinking && llmStatus.ready && (
                <div style={{ marginTop: "16px", padding: "10px 14px", background: "rgba(251, 191, 36, 0.08)", border: "1px dashed rgb(251, 191, 36)", borderRadius: "8px", fontSize: "0.75rem", color: "var(--md-sys-color-on-surface)", lineHeight: "1.45" }}>
                  <strong>Thinking not supported.</strong> The loaded model does not support reasoning/thinking output. DeepThink is only available for models like DeepSeek-R1, Qwen3, Gemma-4-E2B, and other reasoning-capable models.
                </div>
              )}

              {/* Temperature slider */}
              <div className="m3-slider-group" style={{ marginTop: "16px" }}>
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Temperature (Creativity)</span>
                  <span className="m3-slider-value">{textSettings.temperature}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.temperature}
                  onChange={(e) => updateTextSetting("temperature", parseFloat(e.target.value))}
                  min="0.1"
                  max="2.0"
                  step="0.05"
                />
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", lineHeight: "1.3" }}>
                  Lower temperature produces focused and coherent replies; higher temperature allows more creative and diverse responses.
                </span>
              </div>

              {/* CPU/GPU Mode Toggle */}
              {(specs?.gpu_name && !specs.gpu_name.includes("Loading") && specs.gpu_name !== "Unavailable") && (
                <div className="m3-slider-group" style={{ marginTop: "16px" }}>
                  <div className="m3-slider-header">
                    <span className="m3-slider-label">Text Generation Backend</span>
                    <span className="m3-slider-value">
                      {(textSettings.gpuLayers === 0 || textSettings.gpuLayers === undefined) ? "CPU" : "GPU"}
                    </span>
                  </div>
                  <div className="m3-segmented-button" style={{ marginTop: "8px" }}>
                    <div
                      className={`m3-segment-item ${(textSettings.gpuLayers === 0 || textSettings.gpuLayers === undefined) ? "active" : ""}`}
                      onClick={() => updateTextSetting("gpuLayers", 0)}
                      title="Run model entirely on CPU. Best for Intel Arc GPUs which have poor Vulkan performance."
                      style={{ cursor: "pointer" }}
                    >
                      <Cpu size={14} style={{ marginRight: "6px", verticalAlign: "middle" }} />
                      CPU
                    </div>
                    <div
                      className={`m3-segment-item ${(textSettings.gpuLayers !== 0 && textSettings.gpuLayers !== undefined) ? "active" : ""}`}
                      onClick={() => updateTextSetting("gpuLayers", -1)}
                      title="Offload model layers to GPU for faster generation."
                      style={{ cursor: "pointer" }}
                    >
                      <Zap size={14} style={{ marginRight: "6px", verticalAlign: "middle" }} />
                      GPU
                    </div>
                  </div>
                  <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", lineHeight: "1.3", marginTop: "8px", display: "block" }}>
                    {(textSettings.gpuLayers === 0 || textSettings.gpuLayers === undefined) ? (
                      <span>
                        <strong>CPU mode:</strong> Uses processor only. Recommended for Intel Arc GPUs which currently perform better on CPU with llama.cpp.
                      </span>
                    ) : (
                      <span>
                        <strong>GPU mode:</strong> Offloads model layers to graphics card. Best for NVIDIA/AMD GPUs. Intel Arc may be slower due to Vulkan driver limitations.
                      </span>
                    )}
                  </span>
                </div>
              )}

              {/* GPU Layers slider - only show when GPU mode is selected */}
              {(specs?.gpu_name && !specs.gpu_name.includes("Loading") && specs.gpu_name !== "Unavailable") && (textSettings.gpuLayers !== 0 && textSettings.gpuLayers !== undefined) && (
                <div className="m3-slider-group" style={{ marginTop: "16px", padding: "12px", background: "rgba(99, 102, 241, 0.05)", borderRadius: "8px", border: "1px solid rgba(99, 102, 241, 0.2)" }}>
                  <div className="m3-slider-header">
                    <span className="m3-slider-label">GPU Layer Offload</span>
                    <span className="m3-slider-value">
                      {textSettings.gpuLayers === -1 ? "All layers" : `${textSettings.gpuLayers} layers`}
                    </span>
                  </div>
                  <input
                    type="range"
                    className="m3-slider"
                    value={textSettings.gpuLayers === -1 ? 999 : textSettings.gpuLayers}
                    onChange={(e) => {
                      const val = parseInt(e.target.value);
                      updateTextSetting("gpuLayers", val === 999 ? -1 : val);
                    }}
                    min="0"
                    max="999"
                    step="1"
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.7rem", color: "var(--md-sys-color-outline)", marginTop: "4px" }}>
                    <span>0 (CPU only)</span>
                    <span>All (-1)</span>
                  </div>
                  <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", lineHeight: "1.3", marginTop: "8px", display: "block" }}>
                    <strong>More layers = faster but uses more VRAM.</strong> Start with "All" and reduce if you get out-of-memory errors. 
                    {textSettings.gpuLayers === -1 && " Currently all layers will be loaded into GPU memory."}
                    {textSettings.gpuLayers !== -1 && textSettings.gpuLayers !== 0 && ` Currently ${textSettings.gpuLayers} layers on GPU, rest on CPU.`}
                  </span>
                </div>
              )}

              {/* CPU-only fallback message when no GPU detected */}
              {(!specs?.gpu_name || specs.gpu_name.includes("Loading") || specs.gpu_name === "Unavailable") && (
                <div style={{ 
                  marginTop: "16px", 
                  padding: "10px 14px", 
                  background: "rgba(251, 191, 36, 0.08)", 
                  border: "1px dashed rgb(251, 191, 36)", 
                  borderRadius: "8px",
                  fontSize: "0.75rem",
                  color: "var(--md-sys-color-on-surface)",
                  lineHeight: "1.45"
                }}>
                  <strong>No GPU detected.</strong> Text generation will use CPU only. Install GPU drivers or restart if you have a dedicated graphics card.
                </div>
              )}

              {/* Performance Profile Preset */}
              <div className="m3-text-field" style={{ marginTop: "16px" }}>
                <label className="m3-text-field-label">Performance Profile</label>
                <select
                  value={textSettings.performanceProfile || "balanced"}
                  onChange={(e) => {
                    const profile = e.target.value;
                    updateTextSetting("performanceProfile", profile);
                    // Auto-apply recommended settings for the profile
                    if (profile === "potato") {
                      updateTextSetting("contextSize", 2048);
                      updateTextSetting("cacheTypeK", "q4_0");
                      updateTextSetting("cacheTypeV", "q4_0");
                      updateTextSetting("mlock", true);
                      updateTextSetting("gpuLayers", 0);
                    } else if (profile === "balanced") {
                      updateTextSetting("contextSize", 4096);
                      updateTextSetting("cacheTypeK", "q8_0");
                      updateTextSetting("cacheTypeV", "q8_0");
                      updateTextSetting("mlock", false);
                      updateTextSetting("gpuLayers", -1);
                    } else if (profile === "high") {
                      updateTextSetting("contextSize", 8192);
                      updateTextSetting("cacheTypeK", "q8_0");
                      updateTextSetting("cacheTypeV", "q8_0");
                      updateTextSetting("mlock", false);
                      updateTextSetting("gpuLayers", -1);
                    }
                  }}
                  className="m3-input"
                  style={{ marginTop: "6px", height: "40px", cursor: "pointer" }}
                >
                  <option value="potato">🥔 Potato PC (Low-end CPU, no GPU)</option>
                  <option value="balanced">⚖️ Balanced (Mid-range GPU/CPU)</option>
                  <option value="high">🚀 High-End (Fast GPU, 16GB+ VRAM)</option>
                  <option value="custom">🔧 Custom (Manual settings)</option>
                </select>
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "4px" }}>
                  One-click optimization for your hardware tier. Select "Custom" to fine-tune individual settings.
                </span>
              </div>

              {/* Advanced Settings Toggle */}
              <details style={{ marginTop: "16px" }}>
                <summary style={{ 
                  fontSize: "0.85rem", 
                  fontWeight: 600, 
                  color: "var(--md-sys-color-primary)",
                  cursor: "pointer",
                  userSelect: "none"
                }}>
                  Advanced Settings
                </summary>
                <div style={{ marginTop: "12px", paddingLeft: "8px" }}>
                  
                  {/* CPU Threads */}
                  <div className="m3-slider-group" style={{ marginTop: "12px" }}>
                    <div className="m3-slider-header">
                      <span className="m3-slider-label">CPU Threads</span>
                      <span className="m3-slider-value">{textSettings.threads || specs?.cpu_cores_physical || 4}</span>
                    </div>
                    <input
                      type="range"
                      className="m3-slider"
                      value={textSettings.threads || specs?.cpu_cores_physical || 4}
                      onChange={(e) => updateTextSetting("threads", parseInt(e.target.value))}
                      min="1"
                      max="64"
                      step="1"
                    />
                    <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", lineHeight: "1.3" }}>
                      Lower = less oversaturation on GPU mode. Auto-detected: {specs?.cpu_cores_physical || 4} physical cores.
                    </span>
                  </div>

                  {/* Max Tokens */}
                  <div className="m3-slider-group" style={{ marginTop: "12px" }}>
                    <div className="m3-slider-header">
                      <span className="m3-slider-label">Max Tokens</span>
                      <span className="m3-slider-value">{textSettings.maxTokens || 1024}</span>
                    </div>
                    <input
                      type="range"
                      className="m3-slider"
                      value={textSettings.maxTokens || 1024}
                      onChange={(e) => updateTextSetting("maxTokens", parseInt(e.target.value))}
                      min="128"
                      max="4096"
                      step="128"
                    />
                    <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", lineHeight: "1.3" }}>
                      Maximum tokens to generate per response.
                    </span>
                  </div>

                  {/* Top P */}
                  <div className="m3-slider-group" style={{ marginTop: "12px" }}>
                    <div className="m3-slider-header">
                      <span className="m3-slider-label">Top P</span>
                      <span className="m3-slider-value">{textSettings.topP || 0.95}</span>
                    </div>
                    <input
                      type="range"
                      className="m3-slider"
                      value={textSettings.topP || 0.95}
                      onChange={(e) => updateTextSetting("topP", parseFloat(e.target.value))}
                      min="0"
                      max="1"
                      step="0.05"
                    />
                  </div>

                  {/* Top K */}
                  <div className="m3-slider-group" style={{ marginTop: "12px" }}>
                    <div className="m3-slider-header">
                      <span className="m3-slider-label">Top K</span>
                      <span className="m3-slider-value">{textSettings.topK || 40}</span>
                    </div>
                    <input
                      type="range"
                      className="m3-slider"
                      value={textSettings.topK || 40}
                      onChange={(e) => updateTextSetting("topK", parseInt(e.target.value))}
                      min="1"
                      max="100"
                      step="1"
                    />
                  </div>

                  {/* Min P */}
                  <div className="m3-slider-group" style={{ marginTop: "12px" }}>
                    <div className="m3-slider-header">
                      <span className="m3-slider-label">Min P</span>
                      <span className="m3-slider-value">{textSettings.minP || 0.05}</span>
                    </div>
                    <input
                      type="range"
                      className="m3-slider"
                      value={textSettings.minP || 0.05}
                      onChange={(e) => updateTextSetting("minP", parseFloat(e.target.value))}
                      min="0"
                      max="1"
                      step="0.01"
                    />
                  </div>

                  {/* Repeat Penalty */}
                  <div className="m3-slider-group" style={{ marginTop: "12px" }}>
                    <div className="m3-slider-header">
                      <span className="m3-slider-label">Repeat Penalty</span>
                      <span className="m3-slider-value">{textSettings.repeatPenalty || 1.1}</span>
                    </div>
                    <input
                      type="range"
                      className="m3-slider"
                      value={textSettings.repeatPenalty || 1.1}
                      onChange={(e) => updateTextSetting("repeatPenalty", parseFloat(e.target.value))}
                      min="0.5"
                      max="2.0"
                      step="0.05"
                    />
                  </div>

                  {/* KV Cache Type K */}
                  <div className="m3-text-field" style={{ marginTop: "12px" }}>
                    <label className="m3-text-field-label">KV Cache Type K</label>
                    <select
                      value={textSettings.cacheTypeK || "q8_0"}
                      onChange={(e) => updateTextSetting("cacheTypeK", e.target.value)}
                      className="m3-input"
                      style={{ marginTop: "6px", height: "40px", cursor: "pointer" }}
                    >
                      <option value="f16">f16 (Highest quality, most memory)</option>
                      <option value="q8_0">q8_0 (Balanced, 2x memory reduction)</option>
                      <option value="q4_0">q4_0 (Aggressive, 4x memory reduction)</option>
                    </select>
                  </div>

                  {/* KV Cache Type V */}
                  <div className="m3-text-field" style={{ marginTop: "12px" }}>
                    <label className="m3-text-field-label">KV Cache Type V</label>
                    <select
                      value={textSettings.cacheTypeV || "q8_0"}
                      onChange={(e) => updateTextSetting("cacheTypeV", e.target.value)}
                      className="m3-input"
                      style={{ marginTop: "6px", height: "40px", cursor: "pointer" }}
                    >
                      <option value="f16">f16 (Highest quality, most memory)</option>
                      <option value="q8_0">q8_0 (Balanced, 2x memory reduction)</option>
                      <option value="q4_0">q4_0 (Aggressive, 4x memory reduction)</option>
                    </select>
                  </div>

                  {/* Flash Attention Toggle */}
                  <div style={{ marginTop: "12px" }}>
                    <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "0.85rem" }}>
                      <input
                        type="checkbox"
                        checked={textSettings.flashAttn !== false}
                        onChange={(e) => updateTextSetting("flashAttn", e.target.checked)}
                        style={{ width: "16px", height: "16px", marginTop: "3px", accentColor: "var(--md-sys-color-primary)", cursor: "pointer" }}
                      />
                      <div>
                        <strong>Flash Attention</strong>
                        <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "2px" }}>
                          Memory-efficient attention for faster generation and lower VRAM usage.
                        </div>
                      </div>
                    </label>
                  </div>

                  {/* Memory Lock (mlock) Toggle */}
                  <div style={{ marginTop: "12px" }}>
                    <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "0.85rem" }}>
                      <input
                        type="checkbox"
                        checked={textSettings.mlock === true}
                        onChange={(e) => updateTextSetting("mlock", e.target.checked)}
                        style={{ width: "16px", height: "16px", marginTop: "3px", accentColor: "var(--md-sys-color-primary)", cursor: "pointer" }}
                      />
                      <div>
                        <strong>Memory Lock (mlock)</strong>
                        <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "2px" }}>
                          Prevent OS from paging model to disk. Recommended for CPU mode.
                        </div>
                      </div>
                    </label>
                  </div>

                  {/* Memory Map (mmap) Toggle */}
                  <div style={{ marginTop: "12px" }}>
                    <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "0.85rem" }}>
                      <input
                        type="checkbox"
                        checked={textSettings.mmap !== false}
                        onChange={(e) => updateTextSetting("mmap", e.target.checked)}
                        style={{ width: "16px", height: "16px", marginTop: "3px", accentColor: "var(--md-sys-color-primary)", cursor: "pointer" }}
                      />
                      <div>
                        <strong>Memory Map (mmap)</strong>
                        <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "2px" }}>
                          Faster model loading via memory-mapped files.
                        </div>
                      </div>
                    </label>
                  </div>

                  {/* Seed */}
                  <div className="m3-text-field" style={{ marginTop: "12px" }}>
                    <label className="m3-text-field-label">Seed (optional)</label>
                    <input
                      type="number"
                      value={textSettings.seed || ""}
                      onChange={(e) => updateTextSetting("seed", e.target.value ? parseInt(e.target.value) : null)}
                      placeholder="Random"
                      className="m3-input"
                      style={{ marginTop: "6px", height: "40px" }}
                    />
                    <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "4px" }}>
                      Set for reproducible outputs. Leave empty for random.
                    </span>
                  </div>
                </div>
              </details>

              {/* NPU Detection Badge */}
              {specs?.npu?.detected && (
                <div style={{
                  marginTop: "16px",
                  padding: "10px 14px",
                  background: "rgba(99, 102, 241, 0.08)",
                  border: "1px dashed var(--md-sys-color-primary)",
                  borderRadius: "8px",
                  fontSize: "0.75rem",
                  color: "var(--md-sys-color-on-surface)",
                  lineHeight: "1.45"
                }}>
                  <strong>Intel NPU detected.</strong> NPU text generation via OpenVINO/IPEX-LLM is on the roadmap for future updates.
                </div>
              )}
            </div>
          </div>

          {/* Card 5: System Settings (Generation Backend) */}
          <div className="m3-card">
            <h3 className="m3-card-title">
              <Cpu size={18} style={{ color: "var(--md-sys-color-primary)" }} />
              5. Image Generation Backend
            </h3>
            
            <div className="m3-field-group">
              <div className="m3-text-field">
                <label className="m3-text-field-label">Active Image Accelerator</label>
                <div className="m3-segmented-button">
                  {availableBackends.map((backend) => (
                    <div
                      key={backend.id}
                      className={`m3-segment-item ${constraints.backendType === backend.id || (!constraints.backendType && backend.id === "cpu") ? "active" : ""}`}
                      onClick={() => handleBackendChange(backend.id)}
                      title={backend.id === "cuda" ? "CUDA appears only when an NVIDIA CUDA backend is available." : undefined}
                      style={{ cursor: "pointer" }}
                    >
                      {backend.label}
                    </div>
                  ))}
                </div>
                 <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "4px", lineHeight: 1.35 }}>
                  {isMac ? (
                    "CPU is slow but safest. Metal uses your Mac's graphics card. Apple Neural Engine (NPU) is highly power-efficient and fast."
                  ) : (
                    "CPU is slow but safest. Vulkan works on supported GPUs. CUDA is shown only when NVIDIA CUDA support is available."
                  )}
                 </span>
                
                {constraints.backendType === "cuda" && specs?.gpu_name && String(specs.gpu_name).toLowerCase().includes("gtx") && (
                  <div style={{
                    marginTop: "12px",
                    padding: "10px 14px",
                    background: "rgba(239, 68, 68, 0.08)",
                    border: "1px dashed rgb(239, 68, 68)",
                    borderRadius: "8px",
                    fontSize: "0.75rem",
                    color: "var(--md-sys-color-on-surface)",
                    lineHeight: "1.45"
                  }}>
                    <strong>Performance Alert:</strong> Your graphics card (<code>{specs.gpu_name}</code>) is a GTX-series GPU which lacks hardware <strong>Tensor Cores</strong>. Running in CUDA mode will be up to 3x slower. We strongly recommend switching to <strong>Vulkan GPU</strong> for optimal generation speed.
                  </div>
                )}
                
                {backendOptions?.unavailable?.length > 0 && (
                  <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "4px" }}>
                    {backendOptions.unavailable.map((backend) => (
                      <span key={backend.id} style={{ fontSize: "0.75rem", color: "var(--md-sys-color-error)", lineHeight: 1.35 }}>
                        {backend.label} unavailable: {backend.reason}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(Settings);
