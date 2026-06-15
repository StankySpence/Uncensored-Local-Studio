import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bot, LoaderCircle, Send, Trash2, Square, History, Plus, Paperclip, X } from "lucide-react";
import {
  chatWithLlm,
  getDownloadProgress,
  getLlmStatus,
  listLlmModels,
  startLlm,
  stopLlm,
} from "../services/api";

function TextChat({ specs, showAlert, showConfirm, textSettings, setTextSettings, setActiveModel, setServerRunning }) {
  const [models, setModels] = useState([]);
  const [status, setStatus] = useState({ ready: false, running: false, settings: {} });
  const [selectedModel, setSelectedModel] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [loadingModel, setLoadingModel] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [showHistory, setShowHistory] = useState(true);
  const [tokenUsage, setTokenUsage] = useState({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  });
  
  const bottomRef = useRef(null);
  const completedDownloadRef = useRef("");
  const loadingModelRef = useRef(null);

  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);

  const isImage = (file) => {
    return /\.(jpe?g|png|webp)$/i.test(file.name) || file.type.startsWith("image/");
  };

  const isTextFile = (file) => {
    return /\.(txt|md|csv|js|jsx|ts|tsx|py|json|css|html|java|cpp|c|h|rs|go|sh|bat|xml|yaml|yml)$/i.test(file.name) || file.type.startsWith("text/");
  };

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files);
    if (!files || files.length === 0) return;

    files.forEach((file) => {
      if (isImage(file)) {
        const reader = new FileReader();
        reader.onload = (event) => {
          setAttachments((prev) => [
            ...prev,
            {
              id: Math.random().toString(36).substring(7),
              file,
              type: "image",
              name: file.name,
              dataUrl: event.target.result,
            },
          ]);
        };
        reader.readAsDataURL(file);
      } else if (isTextFile(file)) {
        const reader = new FileReader();
        reader.onload = (event) => {
          setAttachments((prev) => [
            ...prev,
            {
              id: Math.random().toString(36).substring(7),
              file,
              type: "document",
              name: file.name,
              content: event.target.result,
            },
          ]);
        };
        reader.readAsText(file);
      } else {
        showAlert({
          title: "Unsupported File",
          message: `File "${file.name}" is not supported. Please select an image (JPEG, PNG, WEBP) or a text/code file.`,
          danger: true,
        });
      }
    });

    e.target.value = "";
  };

  useEffect(() => {
    loadingModelRef.current = loadingModel;
  }, [loadingModel]);

  // Load conversations on mount
  useEffect(() => {
    const saved = localStorage.getItem("chat_conversations");
    if (saved) {
      try {
        setConversations(JSON.parse(saved));
      } catch (_) {}
    }
  }, []);

  const refresh = useCallback(async () => {
    const [nextModels, nextStatus] = await Promise.all([listLlmModels(), getLlmStatus()]);
    setModels(nextModels);
    setStatus(nextStatus);
    const active = nextStatus.settings?.model;
    setSelectedModel((current) => {
      const saved = localStorage.getItem("selectedLlmModel");
      const savedExists = nextModels.some((m) => m.filename === saved);
      return active || current || (savedExists ? saved : "") || nextModels[0]?.filename || "";
    });
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
    const timer = setInterval(() => {
      getLlmStatus().then((nextStatus) => {
        setStatus(nextStatus);
        // If it suddenly loaded or became ready externally, update selection and reset loading states
        if (nextStatus.ready && nextStatus.settings?.model) {
          setSelectedModel(nextStatus.settings.model);
          setLoadingModel(null);
        }
      }).catch(() => {});
      getDownloadProgress().then((state) => {
        if (state.kind === "text" && (state.active || state.error || state.progress === 100)) {
          const completionKey = `${state.filename || ""}:${state.downloadedBytes || 0}`;
          if (!state.active && !state.error && completedDownloadRef.current !== completionKey) {
            completedDownloadRef.current = completionKey;
            refresh().catch(() => {});
          }
        }
      }).catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isBusy, loadingModel]);

  const handleModelChange = async (filename) => {
    if (!filename) {
      if (status.ready) {
        setIsBusy(true);
        try {
          await stopLlm();
          setStatus((prev) => ({ ...prev, ready: false, running: false }));
          setSelectedModel("");
          setMessages([]);
          setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        } catch (err) {
          showAlert({ title: "Unload Failed", message: err.message || String(err), danger: true });
        } finally {
          setIsBusy(false);
        }
      }
      return;
    }

    setSelectedModel(filename);
    localStorage.setItem("selectedLlmModel", filename);
    setIsBusy(true);
    setLoadingModel(filename);
    try {
      // Unload active image engine if running
      if (setActiveModel) setActiveModel(null);
      if (setServerRunning) setServerRunning(false);

      const result = await startLlm(filename, {
        threads: textSettings?.threads || specs?.cpu_cores_physical || 4,
        contextSize: textSettings?.contextSize || 4096,
        gpuLayers: -1,
      });
      setStatus({ ...status, ...result, ready: true, running: true, settings: result.settings });
      setMessages([]);
      setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    } catch (err) {
      if (loadingModelRef.current === filename) {
        showAlert({ title: "Text Model Load Failed", message: err.message, danger: true });
      }
    } finally {
      setLoadingModel(null);
      setIsBusy(false);
    }
  };

  const handleCancelLlmLoad = async () => {
    try {
      await stopLlm();
    } catch (_) {}
    setLoadingModel(null);
    setIsBusy(false);
    setSelectedModel("");
  };

  const saveConversationState = (id, msgs, modelName, newTitle = null) => {
    const saved = localStorage.getItem("chat_conversations");
    let list = [];
    if (saved) {
      try {
        list = JSON.parse(saved);
      } catch (_) {}
    }
    const idx = list.findIndex(c => c.id === id);
    if (idx !== -1) {
      list[idx].messages = msgs;
      list[idx].timestamp = Date.now();
      list[idx].model = modelName;
      if (newTitle) list[idx].title = newTitle;
    } else {
      list.unshift({
        id,
        title: newTitle || "Chat Session",
        model: modelName,
        messages: msgs,
        timestamp: Date.now()
      });
    }
    localStorage.setItem("chat_conversations", JSON.stringify(list));
    setConversations(list);
  };

  const handleNewChat = () => {
    setActiveConversationId(null);
    setMessages([]);
    setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  };

  const handleSelectConversation = (conv) => {
    setActiveConversationId(conv.id);
    setMessages(conv.messages);
    if (conv.model && models.some(m => m.filename === conv.model)) {
      setSelectedModel(conv.model);
    }
    // Try to compute approximate token usage from messages
    const total = conv.messages.reduce((sum, m) => {
      const text = Array.isArray(m.content)
        ? m.content.map(c => c.text || "").join(" ")
        : (m.content || "");
      return sum + text.split(/\s+/).length;
    }, 0);
    setTokenUsage({
      prompt_tokens: Math.round(total * 0.7),
      completion_tokens: Math.round(total * 0.3),
      total_tokens: total
    });
  };

  const handleDeleteConversation = (id, e) => {
    e.stopPropagation();
    const saved = localStorage.getItem("chat_conversations");
    if (!saved) return;
    try {
      const list = JSON.parse(saved);
      const filtered = list.filter(c => c.id !== id);
      localStorage.setItem("chat_conversations", JSON.stringify(filtered));
      setConversations(filtered);
      if (activeConversationId === id) {
        handleNewChat();
      }
    } catch (_) {}
  };

  const sendMessage = async () => {
    const text = input.trim();
    const hasAttachments = attachments.length > 0;
    if ((!text && !hasAttachments) || isBusy || !status.ready) return;

    let convId = activeConversationId;
    let isNew = false;
    if (!convId) {
      convId = "chat_" + Date.now();
      setActiveConversationId(convId);
      isNew = true;
    }

    // Delimited context blocks for document attachments
    let documentContext = "";
    attachments.filter(att => att.type === "document").forEach((att) => {
      documentContext += `\n[Attached File: ${att.name}]\n${att.content}\n`;
    });

    const combinedText = documentContext ? `${text}\n\n${documentContext}`.trim() : text;
    const imageAttachments = attachments.filter(att => att.type === "image");

    let userMessageContent;
    if (imageAttachments.length > 0) {
      userMessageContent = [
        {
          type: "text",
          text: combinedText
        },
        ...imageAttachments.map((img) => ({
          type: "image_url",
          image_url: {
            url: img.dataUrl
          }
        }))
      ];
    } else {
      userMessageContent = combinedText;
    }

    const nextMessages = [...messages, { role: "user", content: userMessageContent }];
    setMessages(nextMessages);
    setInput("");
    setIsBusy(true);

    const displayTitleText = text || (imageAttachments.length > 0 ? "Sent Image" : "Sent File");
    const firstTitle = isNew ? (displayTitleText.slice(0, 26) + (displayTitleText.length > 26 ? "..." : "")) : null;
    saveConversationState(convId, nextMessages, selectedModel, firstTitle);

    try {
      const systemPrompt = textSettings?.systemPrompt || "You are a helpful local AI assistant.";
      const requestMessages = [
        ...(systemPrompt.trim() ? [{ role: "system", content: systemPrompt.trim() }] : []),
        ...nextMessages,
      ];
      const response = await chatWithLlm(requestMessages, { 
        temperature: textSettings?.temperature || 0.7, 
        maxTokens: 768 
      });
      const finalMessages = [...nextMessages, { role: "assistant", content: response.content }];
      setMessages(finalMessages);
      if (response.usage) {
        setTokenUsage(response.usage);
      }
      saveConversationState(convId, finalMessages, selectedModel);
      
      // Clean up attached files on success
      setAttachments([]);
    } catch (err) {
      const finalMessages = [...nextMessages, { role: "assistant", content: `Error: ${err.message}`, error: true }];
      setMessages(finalMessages);
      saveConversationState(convId, finalMessages, selectedModel);
    } finally {
      setIsBusy(false);
    }
  };

  const handleClearChat = () => {
    setMessages([]);
    setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    if (activeConversationId) {
      saveConversationState(activeConversationId, [], selectedModel);
    }
  };

  return (
    <div className="text-chat-layout" style={{ display: "flex", gap: "16px", padding: "20px", height: "100%", width: "100%", boxSizing: "border-box", overflow: "hidden" }}>
      {/* Collapsible Chat History Sidebar */}
      {showHistory && (
        <aside className="chat-history-sidebar">
          <button
            className="m3-btn m3-btn-tonal"
            onClick={handleNewChat}
            style={{
              width: "100%",
              height: "40px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              fontSize: "0.85rem",
              fontWeight: "600",
              borderRadius: "var(--md-shape-corner-medium)",
              cursor: "pointer",
              border: "1px solid var(--border-color)"
            }}
          >
            <Plus size={16} />
            <span>New Chat</span>
          </button>
          
          <div className="history-items-list">
            {conversations.length === 0 ? (
              <div style={{ padding: "20px 10px", textAlign: "center", fontSize: "0.8rem", color: "var(--md-sys-color-outline)", opacity: 0.8 }}>
                No saved chats
              </div>
            ) : (
              conversations.map((conv) => {
                const isActive = activeConversationId === conv.id;
                const formattedDate = new Date(conv.timestamp).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit"
                });
                return (
                  <div
                    key={conv.id}
                    className={`history-item ${isActive ? "active" : ""}`}
                    onClick={() => handleSelectConversation(conv)}
                  >
                    <div className="history-item-info">
                      <span className="history-item-title">{conv.title}</span>
                      <span className="history-item-meta">{formattedDate} • {conv.model?.split(/[\\/]/).pop() || "GGUF"}</span>
                    </div>
                    <button
                      className="history-item-delete"
                      onClick={(e) => handleDeleteConversation(conv.id, e)}
                      title="Delete Conversation"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>
      )}

      <section className="text-chat-main" style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column" }}>
        <div className="text-chat-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {/* Toggle History Sidebar button */}
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="m3-btn m3-btn-tonal"
              style={{
                height: "38px",
                width: "38px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "var(--md-shape-corner-medium)",
                cursor: "pointer",
                background: showHistory ? "var(--md-sys-color-primary-container)" : "var(--md-sys-color-surface-variant)",
                color: showHistory ? "var(--md-sys-color-on-primary-container)" : "var(--md-sys-color-on-surface)",
                border: "1px solid var(--border-color)",
                flexShrink: 0
              }}
              title="Toggle Chat History"
            >
              <History size={18} />
            </button>

            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={isBusy}
              style={{
                fontSize: "0.95rem",
                fontWeight: "600",
                border: "1px solid var(--border-color)",
                borderRadius: "var(--md-shape-corner-medium)",
                background: "var(--md-sys-color-surface-variant)",
                color: "var(--md-sys-color-on-surface)",
                padding: "8px 16px",
                outline: "none",
                cursor: "pointer",
                minWidth: "220px"
              }}
            >
              <option value="">No model loaded (Select GGUF)</option>
              {models.map((m) => (
                <option key={m.filename} value={m.filename}>
                  {m.filename} {m.filename === status.settings?.model && status.ready ? "• Active" : ""}
                </option>
              ))}
            </select>
            {isBusy && !loadingModel && <LoaderCircle className="progress-spinner" size={16} />}
            {selectedModel && (!status.ready || status.settings?.model !== selectedModel) && !loadingModel && (
              <button
                className="m3-btn m3-btn-filled"
                onClick={() => handleModelChange(selectedModel)}
                disabled={isBusy}
                style={{
                  height: "38px",
                  padding: "0 16px",
                  fontSize: "0.85rem",
                  borderRadius: "var(--md-shape-corner-medium)",
                  background: "var(--md-sys-color-primary)",
                  color: "var(--md-sys-color-on-primary)",
                  cursor: "pointer",
                  border: "none",
                  fontWeight: "600",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                Load Model
              </button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>

            {/* Small circular gauge for context */}
            {(() => {
              const maxTokens = status.settings?.contextSize || 4096;
              const used = tokenUsage.total_tokens || 0;
              const percent = Math.min(100, Math.round((used / maxTokens) * 100));
              
              return (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }} title={`Context Used: ${used} / ${maxTokens} tokens`}>
                  <div style={{ position: "relative", width: "40px", height: "40px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="40" height="40" viewBox="0 0 40 40">
                      <circle cx="20" cy="20" r="16" stroke="var(--border-color)" strokeWidth="3" fill="transparent" />
                      <circle 
                        cx="20" 
                        cy="20" 
                        r="16" 
                        stroke="var(--md-sys-color-primary)" 
                        strokeWidth="3" 
                        fill="transparent" 
                        strokeDasharray={2 * Math.PI * 16}
                        strokeDashoffset={2 * Math.PI * 16 * (1 - percent / 100)}
                        strokeLinecap="round"
                        transform="rotate(-90 20 20)"
                        style={{ transition: "stroke-dashoffset 0.35s" }}
                      />
                    </svg>
                    <div style={{ position: "absolute", textAlign: "center" }}>
                      <span style={{ fontSize: "0.65rem", fontWeight: "700" }}>{percent}%</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                    <span style={{ fontSize: "0.65rem", color: "var(--md-sys-color-outline)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Context Used
                    </span>
                    <span style={{ fontSize: "0.8rem", fontWeight: "600", color: "var(--md-sys-color-on-surface)" }}>
                      {used} / {maxTokens}
                    </span>
                  </div>
                </div>
              );
            })()}

            {/* Clear Conversation button */}
            <button 
              className="m3-btn m3-btn-outlined" 
              style={{ 
                height: "36px", 
                padding: "0 12px", 
                display: "flex", 
                alignItems: "center", 
                gap: "6px", 
                fontSize: "0.82rem",
                borderRadius: "var(--md-shape-corner-medium)"
              }}
              onClick={handleClearChat}
              disabled={messages.length === 0}
            >
              <Trash2 size={15} />
              <span>Clear</span>
            </button>
          </div>
        </div>

        <div className="chat-messages">
          {loadingModel ? (
            <div className="chat-empty" style={{ maxWidth: "480px", margin: "auto", textAlign: "center", padding: "60px 20px" }}>
              <LoaderCircle className="progress-spinner" size={48} style={{ color: "var(--md-sys-color-primary)", marginBottom: "16px" }} />
              <h3 style={{ fontWeight: 600, fontSize: "1.25rem", marginBottom: "8px", color: "var(--md-sys-color-on-surface)" }}>Loading Text Model</h3>
              <code style={{ 
                display: "block", 
                background: "var(--md-sys-color-surface-variant)", 
                color: "var(--md-sys-color-on-surface-variant)",
                padding: "8px 12px", 
                borderRadius: "6px", 
                fontSize: "0.85rem",
                marginBottom: "20px",
                wordBreak: "break-all",
                fontFamily: "monospace"
              }}>
                {loadingModel}
              </code>
              <p style={{ fontSize: "0.9rem", color: "var(--md-sys-color-outline)", lineHeight: 1.5, marginBottom: "24px" }}>
                Initializing llama.cpp server and loading the model weights into memory. This can take up to 30 seconds depending on model size and hardware speed.
              </p>
              <button 
                className="m3-btn m3-btn-error" 
                onClick={handleCancelLlmLoad}
                style={{ 
                  display: "inline-flex", 
                  alignItems: "center", 
                  gap: "8px",
                  height: "38px",
                  padding: "0 16px",
                  fontSize: "0.85rem",
                  borderRadius: "var(--md-shape-corner-medium)"
                }}
              >
                <Square size={14} fill="currentColor" />
                <span>Cancel Load</span>
              </button>
            </div>
          ) : (
            <>
              {messages.length === 0 && (
                <div className="chat-empty">
                  <Bot size={42} />
                  <h3>Local ChatGPT-style Interface</h3>
                  <p>Choose a GGUF text model above to load it. Your conversation history stays completely private on this machine.</p>
                </div>
              )}
              {messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className={`chat-message ${message.role} ${message.error ? "error" : ""}`}>
                  <strong>{message.role === "user" ? "You" : "Local AI"}</strong>
                  <div>
                    {Array.isArray(message.content) ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {message.content.map((item, idx) => {
                          if (item.type === "text") {
                            return <span key={idx} style={{ whiteSpace: "pre-wrap" }}>{item.text}</span>;
                          }
                          if (item.type === "image_url") {
                            return (
                              <img 
                                key={idx} 
                                src={item.image_url.url} 
                                alt="Attached image" 
                                style={{ maxWidth: "240px", maxHeight: "180px", objectFit: "contain", borderRadius: "6px", marginTop: "4px" }} 
                              />
                            );
                          }
                          return null;
                        })}
                      </div>
                    ) : (
                      <span style={{ whiteSpace: "pre-wrap" }}>{message.content}</span>
                    )}
                  </div>
                </div>
              ))}
              {isBusy && status.ready && <div className="chat-thinking"><LoaderCircle className="progress-spinner" size={16} /> Generating...</div>}
            </>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="chat-composer" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {attachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", paddingBottom: "8px" }}>
              {attachments.map((att) => (
                <div key={att.id} style={{ 
                  position: "relative", 
                  display: "flex", 
                  alignItems: "center", 
                  gap: "6px", 
                  padding: "6px 28px 6px 8px", 
                  background: "var(--md-sys-color-surface-variant)", 
                  border: "1px solid var(--border-color)", 
                  borderRadius: "6px", 
                  fontSize: "0.8rem",
                  maxWidth: "200px"
                }}>
                  {att.type === "image" ? (
                    <img src={att.dataUrl} alt={att.name} style={{ width: "24px", height: "24px", objectFit: "cover", borderRadius: "3px" }} />
                  ) : (
                    <span style={{ fontWeight: 600 }}>📄</span>
                  )}
                  <span style={{ 
                    whiteSpace: "nowrap", 
                    overflow: "hidden", 
                    textOverflow: "ellipsis", 
                    color: "var(--md-sys-color-on-surface-variant)" 
                  }} title={att.name}>
                    {att.name}
                  </span>
                  <button 
                    onClick={() => setAttachments(prev => prev.filter(item => item.id !== att.id))}
                    style={{
                      position: "absolute",
                      right: "4px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      color: "var(--md-sys-color-error)",
                      cursor: "pointer",
                      padding: "2px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center"
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: "10px", width: "100%" }}>
            <input 
              type="file" 
              ref={fileInputRef} 
              style={{ display: "none" }} 
              multiple 
              onChange={handleFileChange} 
            />
            <button 
              className="m3-btn m3-btn-tonal" 
              onClick={() => fileInputRef.current?.click()} 
              style={{ padding: "0 12px", height: "48px", display: "flex", alignItems: "center", justifyContent: "center" }}
              disabled={!status.ready || isBusy}
              title="Attach files or images"
            >
              <Paperclip size={17} />
            </button>

            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={status.ready ? "Message your local model..." : "Select and load a GGUF model above to begin"}
              disabled={!status.ready || isBusy}
              style={{ flex: 1 }}
            />
            <button 
              className="m3-btn m3-btn-filled" 
              onClick={sendMessage} 
              disabled={(!input.trim() && attachments.length === 0) || !status.ready || isBusy}
              style={{ height: "48px" }}
            >
              <Send size={17} /> Send
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export default TextChat;
