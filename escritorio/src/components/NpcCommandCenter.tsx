"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  BarChart3,
  BellRing,
  BookOpen,
  Bot,
  Brain,
  ClipboardList,
  Clock3,
  Code2,
  DollarSign,
  ExternalLink,
  FileText,
  FileUp,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Layers3,
  MessageSquare,
  Pencil,
  RotateCcw,
  Save,
  Settings2,
  Sheet,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import TaskPanel from "@/components/TaskPanel";
import NpcKeysTab from "@/components/NpcKeysTab";

export interface NpcCommandCenterNpc {
  id: string;
  name: string;
  runtimeProvider?: string | null;
  model?: string | null;
  hasAgent?: boolean;
  totalTokens?: number;
  identity?: string | null;
  soul?: string | null;
  passPolicy?: string | null;
}

interface LibraryItem {
  id: string;
  npcId: string;
  layer: string;
  category: string;
  name: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
}

interface MemoryItem {
  id: string;
  npcId: string;
  memoryType: string;
  title: string;
  content: string;
  pinned: boolean;
  metadata: Record<string, unknown> | null;
  createdAt?: string;
}

interface RecentChat {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
}

interface TaskMemory {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  updatedAt?: string;
}

interface MeetingMemory {
  id: string;
  topic: string;
  transcript: string;
  keyTopics: string[];
  conclusions: string | null;
  createdAt?: string;
}

interface AutomationRule {
  id: string;
  kind: string;
  title: string;
  description: string;
  enabled: boolean;
  schedule: "manual" | "daily" | "event";
  time?: string;
  trigger?: string;
}

interface MemoryResponse {
  manualMemories: MemoryItem[];
  recentChats: RecentChat[];
  tasks: TaskMemory[];
  meetings: MeetingMemory[];
  memoryLayers: {
    firstLayer: number;
    secondLayer: number;
    longTerm: number;
  };
}

interface NpcCommandCenterProps {
  channelId: string;
  characterId: string | null;
  npc: NpcCommandCenterNpc | null;
  socket: Socket | null;
  isOpen: boolean;
  onClose: () => void;
  onOpenChat: (npcId: string, npcName: string) => void;
  onEditNpc: (npcId: string) => void;
  onResetChat: (npcId: string) => void;
  onNpcUpdated?: (npcId: string) => void;
  embedded?: boolean;
}

type CommandCenterTab = "summary" | "tasks" | "library" | "memory" | "tools" | "automation" | "report";

// Cores e ícones amigáveis por tipo de operação no relatório
const KIND_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  "dm": { label: "Chat DM", color: "text-cyan-200", bg: "bg-cyan-500/15 border-cyan-400/30" },
  "meeting": { label: "Reuniões", color: "text-violet-200", bg: "bg-violet-500/15 border-violet-400/30" },
  "task": { label: "Tarefas", color: "text-emerald-200", bg: "bg-emerald-500/15 border-emerald-400/30" },
  "automation": { label: "Automações", color: "text-amber-200", bg: "bg-amber-500/15 border-amber-400/30" },
  "tool": { label: "Ferramentas", color: "text-rose-200", bg: "bg-rose-500/15 border-rose-400/30" },
  "library-context": { label: "Biblioteca", color: "text-sky-200", bg: "bg-sky-500/15 border-sky-400/30" },
};

function kindMeta(kind: string) {
  return KIND_LABELS[kind] || { label: kind, color: "text-slate-200", bg: "bg-white/5 border-white/10" };
}

interface UsageReport {
  totals: {
    promptTokens: number;
    completionTokens: number;
    tokens: number;
    cost: number;
    count: number;
    lastAt: string | null;
    npcTotalTokensCached: number;
  };
  byKind: Record<string, { tokens: number; cost: number; count: number }>;
  byProvider: { provider: string; tokens: number; cost: number; count: number }[];
  topTools: { toolName: string | null; tokens: number; cost: number; count: number }[];
  recentLogs: {
    id: string;
    promptTokens: number;
    completionTokens: number;
    estimatedCost: string | number;
    contextKind: string;
    provider: string | null;
    toolName: string | null;
    label: string | null;
    model: string | null;
    durationMs: number | null;
    isRealUsage: boolean;
    createdAt: string;
  }[];
}

// Providers disponíveis + modelos sugeridos (custos por 1M tokens pra escolher mais barato)
const LLM_PROVIDERS = [
  { value: "channel-default", label: "Padrão do canal" },
  { value: "claude-code", label: "Claude Code (gateway local)" },
  { value: "codex", label: "Codex (gateway local)" },
  { value: "openclaw", label: "OpenClaw (gateway local)" },
  { value: "openai", label: "OpenAI API" },
  { value: "anthropic", label: "Anthropic API" },
  { value: "groq", label: "Groq (grátis/rápido)" },
  { value: "openrouter", label: "OpenRouter (multi-model)" },
  { value: "ollama", label: "Ollama (local)" },
];

const LLM_MODELS: Record<string, { value: string; label: string; cost: string }[]> = {
  "channel-default": [],
  "claude-code": [
    { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", cost: "$3 / $15" },
    { value: "claude-opus-4-7", label: "Claude Opus 4.7", cost: "$15 / $75" },
  ],
  "codex": [
    { value: "gpt-5", label: "GPT-5", cost: "via ChatGPT" },
  ],
  "openclaw": [],
  "openai": [
    { value: "gpt-4o-mini", label: "GPT-4o mini", cost: "$0.15 / $0.60" },
    { value: "gpt-4o", label: "GPT-4o", cost: "$2.50 / $10" },
    { value: "gpt-4.1-mini", label: "GPT-4.1 mini", cost: "$0.40 / $1.60" },
    { value: "o1-mini", label: "o1-mini", cost: "$3 / $12" },
  ],
  "anthropic": [
    { value: "claude-3-5-haiku-20241022", label: "Haiku 3.5", cost: "$0.80 / $4" },
    { value: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5", cost: "$3 / $15" },
  ],
  "groq": [
    { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", cost: "Grátis/rápido" },
    { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B", cost: "Grátis/ultra-rápido" },
    { value: "mixtral-8x7b-32768", label: "Mixtral 8x7B", cost: "Grátis" },
  ],
  "openrouter": [
    { value: "anthropic/claude-3.5-haiku", label: "Claude Haiku 3.5", cost: "$0.80 / $4" },
    { value: "openai/gpt-4o-mini", label: "GPT-4o mini", cost: "$0.15 / $0.60" },
    { value: "meta-llama/llama-3.3-70b", label: "Llama 3.3 70B", cost: "$0.60 / $0.60" },
    { value: "google/gemini-2.0-flash-exp", label: "Gemini 2.0 Flash", cost: "Grátis" },
  ],
  "ollama": [
    { value: "qwen2.5:14b", label: "Qwen 2.5 14B", cost: "Local" },
    { value: "llama3.1:8b", label: "Llama 3.1 8B", cost: "Local" },
    { value: "mistral:7b", label: "Mistral 7B", cost: "Local" },
  ],
};

function formatNumber(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatCost(cost: number) {
  if (cost === 0) return "US$ 0,00";
  if (cost < 0.01) return `US$ ${cost.toFixed(4)}`;
  return `US$ ${cost.toFixed(2)}`;
}

const LIBRARY_LAYER_OPTIONS = [
  { value: "knowledge", label: "Conhecimento" },
  { value: "examples", label: "Exemplos" },
  { value: "rules", label: "Regras" },
  { value: "media", label: "Mídia" },
  { value: "outputs", label: "Saídas" },
  { value: "memory-sources", label: "Fontes de memória" },
];

const MEMORY_TYPE_OPTIONS = [
  { value: "fact", label: "Fato fixo" },
  { value: "episodic", label: "Memória episódica" },
  { value: "summary", label: "Resumo" },
  { value: "relationship", label: "Relacionamento" },
  { value: "working", label: "Memória de trabalho" },
];

function formatProvider(provider?: string | null) {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex") return "Codex";
  if (provider === "openclaw") return "OpenClaw";
  return "Padrão do canal";
}

function formatDateTime(value?: string | null) {
  if (!value) return "Agora";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function extractFileName(metadata: Record<string, unknown> | null) {
  if (!metadata) return null;
  const filename = metadata.filename;
  return typeof filename === "string" ? filename : null;
}

export default function NpcCommandCenter({
  channelId,
  characterId,
  npc,
  socket,
  isOpen,
  onClose,
  onOpenChat,
  onEditNpc,
  onResetChat,
  onNpcUpdated,
  embedded = false,
}: NpcCommandCenterProps) {
  const [tab, setTab] = useState<CommandCenterTab>("summary");
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [memoryData, setMemoryData] = useState<MemoryResponse | null>(null);
  const [automationRules, setAutomationRules] = useState<AutomationRule[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [loadingMemory, setLoadingMemory] = useState(false);
  const [loadingAutomation, setLoadingAutomation] = useState(false);
  const [savingAutomation, setSavingAutomation] = useState(false);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [expandedInfo, setExpandedInfo] = useState<{ title: string; content: string } | null>(null);
  const [selectedMemoryCategory, setSelectedMemoryCategory] = useState<string | null>(null);

  const [libraryLayer, setLibraryLayer] = useState("knowledge");
  const [libraryCategory, setLibraryCategory] = useState("documento");
  const [libraryName, setLibraryName] = useState("");
  const [libraryContent, setLibraryContent] = useState("");
  const [libraryFile, setLibraryFile] = useState<File | null>(null);
  const [submittingLibrary, setSubmittingLibrary] = useState(false);

  const [memoryType, setMemoryType] = useState("fact");
  const [memoryTitle, setMemoryTitle] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryPinned, setMemoryPinned] = useState(false);
  const [submittingMemory, setSubmittingMemory] = useState(false);

  // Relatório / Usage
  const [usageReport, setUsageReport] = useState<UsageReport | null>(null);
  const [usageRange, setUsageRange] = useState<"today" | "7d" | "30d" | "all">("30d");
  const [loadingUsage, setLoadingUsage] = useState(false);

  // Config LLM na própria aba Relatório
  const [llmProvider, setLlmProvider] = useState<string>(npc?.runtimeProvider ?? "channel-default");
  const [llmModel, setLlmModel] = useState<string>(npc?.model ?? "");
  const [savingLlm, setSavingLlm] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (expandedInfo) {
        setExpandedInfo(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expandedInfo, isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      setExpandedInfo(null);
    }
  }, [isOpen, npc?.id]);

  useEffect(() => {
    if (!npc || !isOpen) return;

    void Promise.all([
      (async () => {
        setLoadingLibrary(true);
        try {
          const response = await fetch(`/api/npcs/${npc.id}/library`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Falha ao carregar biblioteca");
          setLibraryItems(data.items || []);
          setSelectedLibraryId((current) => current ?? data.items?.[0]?.id ?? null);
        } catch (error) {
          console.error("[NpcCommandCenter] library", error);
        } finally {
          setLoadingLibrary(false);
        }
      })(),
      (async () => {
        setLoadingMemory(true);
        try {
          const response = await fetch(`/api/npcs/${npc.id}/memory`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Falha ao carregar memória");
          setMemoryData(data);
        } catch (error) {
          console.error("[NpcCommandCenter] memory", error);
        } finally {
          setLoadingMemory(false);
        }
      })(),
      (async () => {
        setLoadingAutomation(true);
        try {
          const response = await fetch(`/api/npcs/${npc.id}/automation`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Falha ao carregar automações");
          setAutomationRules(data.rules || []);
        } catch (error) {
          console.error("[NpcCommandCenter] automation", error);
        } finally {
          setLoadingAutomation(false);
        }
      })(),
    ]);
  }, [isOpen, npc]);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(null), 2600);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  // Sincroniza provider/model quando o NPC muda
  useEffect(() => {
    if (!npc) return;
    setLlmProvider(npc.runtimeProvider ?? "channel-default");
    setLlmModel(npc.model ?? "");
  }, [npc]);

  // Fetch relatório quando a aba abrir ou mudar range
  useEffect(() => {
    if (!npc || !isOpen || tab !== "report") return;
    let cancelled = false;
    (async () => {
      setLoadingUsage(true);
      try {
        const response = await fetch(`/api/npcs/${npc.id}/usage?range=${usageRange}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Falha ao carregar relatório");
        if (!cancelled) setUsageReport(data);
      } catch (error) {
        console.error("[NpcCommandCenter] usage", error);
      } finally {
        if (!cancelled) setLoadingUsage(false);
      }
    })();
    return () => { cancelled = true; };
  }, [npc, isOpen, tab, usageRange]);

  const handleSaveLlmConfig = async () => {
    if (!npc) return;
    setSavingLlm(true);
    try {
      const response = await fetch(`/api/npcs/${npc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runtimeProvider: llmProvider,
          model: llmModel || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Falha ao salvar LLM");
      setStatusMessage("Configuração de LLM salva.");
      onNpcUpdated?.(npc.id);
    } catch (error) {
      console.error("[NpcCommandCenter] save llm", error);
      setStatusMessage(error instanceof Error ? error.message : "Falha ao salvar LLM");
    } finally {
      setSavingLlm(false);
    }
  };

  const selectedLibraryItem = useMemo(
    () => libraryItems.find((item) => item.id === selectedLibraryId) ?? null,
    [libraryItems, selectedLibraryId],
  );

  const memoryItems = useMemo(() => memoryData?.manualMemories ?? [], [memoryData?.manualMemories]);
  const recentChats = memoryData?.recentChats ?? [];
  const recentTasks = memoryData?.tasks ?? [];
  const recentMeetings = memoryData?.meetings ?? [];
  const memoryByCategory = useMemo(() => {
    return memoryItems.reduce((acc, item) => {
      const cat = item.memoryType || "outros";
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(item);
      return acc;
    }, {} as Record<string, MemoryItem[]>);
  }, [memoryItems]);

  if (!isOpen || !npc) return null;

  const enabledAutomationCount = automationRules.filter((rule) => rule.enabled).length;
  const libraryCount = libraryItems.length;

  const categoryMetadata: Record<string, { label: string, icon: any, color: string }> = {
    "reuniao": { label: "Reuniões", icon: <Clock3 className="h-5 w-5" />, color: "text-violet-400" },
    "fato": { label: "Fatos Fixos", icon: <Sparkles className="h-5 w-5" />, color: "text-cyan-400" },
    "tarefa": { label: "Tarefas", icon: <ClipboardList className="h-5 w-5" />, color: "text-emerald-400" },
    "episodica": { label: "Histórico", icon: <BookOpen className="h-5 w-5" />, color: "text-pink-400" },
    "outros": { label: "Outros", icon: <Brain className="h-5 w-5" />, color: "text-slate-400" },
  };

  const memoryCount = memoryItems.length;

  const knowledgeItems = libraryItems.filter((i) => i.layer !== "outputs");
  const outputItems = libraryItems.filter((i) => i.layer === "outputs");

  const outputFileIcon = (fileType: string) => {
    switch (fileType) {
      case "pdf":         return <FileText className="h-5 w-5 text-red-300" />;
      case "image":       return <ImageIcon className="h-5 w-5 text-pink-300" />;
      case "video":       return <Film className="h-5 w-5 text-purple-300" />;
      case "spreadsheet": return <Sheet className="h-5 w-5 text-emerald-300" />;
      case "code":        return <Code2 className="h-5 w-5 text-cyan-300" />;
      default:            return <FileText className="h-5 w-5 text-slate-300" />;
    }
  };

  const outputFileBg = (fileType: string) => {
    switch (fileType) {
      case "pdf":         return "border-red-400/20 bg-red-500/10";
      case "image":       return "border-pink-400/20 bg-pink-500/10";
      case "video":       return "border-purple-400/20 bg-purple-500/10";
      case "spreadsheet": return "border-emerald-400/20 bg-emerald-500/10";
      case "code":        return "border-cyan-400/20 bg-cyan-500/10";
      default:            return "border-white/10 bg-white/5";
    }
  };

  const refreshLibrary = async () => {
    const response = await fetch(`/api/npcs/${npc.id}/library`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Falha ao carregar biblioteca");
    setLibraryItems(data.items || []);
    setSelectedLibraryId((current) => current ?? data.items?.[0]?.id ?? null);
  };

  const refreshMemory = async () => {
    const response = await fetch(`/api/npcs/${npc.id}/memory`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Falha ao carregar memória");
    setMemoryData(data);
  };

  const handleCreateLibraryItem = async () => {
    if (!libraryName.trim()) return;
    setSubmittingLibrary(true);
    try {
      let nextContent = libraryContent.trim() || null;
      let metadata: Record<string, unknown> | null = null;

      if (libraryFile) {
        nextContent = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Falha ao ler arquivo"));
          reader.readAsDataURL(libraryFile);
        });

        metadata = {
          filename: libraryFile.name,
          mime: libraryFile.type,
          size: libraryFile.size,
        };
      }

      const response = await fetch(`/api/npcs/${npc.id}/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          layer: libraryLayer,
          category: libraryCategory.trim() || "documento",
          name: libraryName.trim(),
          content: nextContent,
          metadata,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Falha ao salvar item");

      setLibraryName("");
      setLibraryCategory("documento");
      setLibraryContent("");
      setLibraryFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await refreshLibrary();
      setSelectedLibraryId(data.item?.id ?? null);
      setStatusMessage("Biblioteca do NPC atualizada.");
    } catch (error) {
      console.error("[NpcCommandCenter] create library", error);
      setStatusMessage(error instanceof Error ? error.message : "Falha ao criar item");
    } finally {
      setSubmittingLibrary(false);
    }
  };

  const handleDeleteLibraryItem = async (itemId: string) => {
    try {
      const response = await fetch(`/api/npcs/${npc.id}/library/${itemId}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Falha ao remover item");
      await refreshLibrary();
      if (selectedLibraryId === itemId) {
        setSelectedLibraryId(null);
      }
      setStatusMessage("Item removido da biblioteca.");
    } catch (error) {
      console.error("[NpcCommandCenter] delete library", error);
      setStatusMessage(error instanceof Error ? error.message : "Falha ao remover item");
    }
  };

  const handleCreateMemory = async () => {
    if (!memoryTitle.trim() || !memoryContent.trim()) return;
    setSubmittingMemory(true);
    try {
      const response = await fetch(`/api/npcs/${npc.id}/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memoryType,
          title: memoryTitle.trim(),
          content: memoryContent.trim(),
          pinned: memoryPinned,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Falha ao salvar memória");
      setMemoryTitle("");
      setMemoryContent("");
      setMemoryPinned(false);
      await refreshMemory();
      setStatusMessage("Memória do NPC atualizada.");
    } catch (error) {
      console.error("[NpcCommandCenter] create memory", error);
      setStatusMessage(error instanceof Error ? error.message : "Falha ao salvar memória");
    } finally {
      setSubmittingMemory(false);
    }
  };

  const handleDeleteMemory = async (memoryId: string) => {
    try {
      const response = await fetch(`/api/npcs/${npc.id}/memory/${memoryId}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Falha ao apagar memória");
      await refreshMemory();
      setStatusMessage("Memória removida.");
    } catch (error) {
      console.error("[NpcCommandCenter] delete memory", error);
      setStatusMessage(error instanceof Error ? error.message : "Falha ao apagar memória");
    }
  };

  const handleSaveAutomations = async () => {
    setSavingAutomation(true);
    try {
      const response = await fetch(`/api/npcs/${npc.id}/automation`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: automationRules }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Falha ao salvar automações");
      setAutomationRules(data.rules || []);
      setStatusMessage("Configurações proativas salvas.");
    } catch (error) {
      console.error("[NpcCommandCenter] save automations", error);
      setStatusMessage(error instanceof Error ? error.message : "Falha ao salvar automações");
    } finally {
      setSavingAutomation(false);
    }
  };

  return (
    <div className={`${embedded ? "relative h-screen w-screen" : "fixed inset-0"} z-[80] flex ${embedded ? "bg-[#070d1c]" : "bg-black/65"}`}>
      {!embedded && <div className="flex-1" onClick={onClose} />}
      <div className={`relative flex h-full min-h-0 w-full flex-col bg-[#090f1f] shadow-2xl ${embedded ? "max-w-none border-0" : "max-w-[980px] border-l border-white/10"}`}>
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.26em] text-cyan-300/80">Npc Command Center</div>
            <div className="mt-1 flex items-center gap-3">
              <h2 className="text-2xl font-semibold text-white">{npc.name}</h2>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
                {formatProvider(npc.runtimeProvider)}
              </span>
              <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-100">
                {npc.model?.trim() || "Modelo do canal"}
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              Centro de gestão do agente. Aqui ficam a biblioteca individual, a memória em camadas, as ferramentas e as regras proativas do NPC.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {statusMessage && (
              <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
                {statusMessage}
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 hover:bg-white/10 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 overflow-x-auto border-b border-white/10 px-6 py-3">
          <TabButton icon={<Sparkles className="h-4 w-4" />} active={tab === "summary"} onClick={() => setTab("summary")} label="Resumo" />
          <TabButton icon={<ClipboardList className="h-4 w-4" />} active={tab === "tasks"} onClick={() => setTab("tasks")} label="Tarefas" />
          <TabButton icon={<BookOpen className="h-4 w-4" />} active={tab === "library"} onClick={() => setTab("library")} label="Biblioteca" />
          <TabButton icon={<Brain className="h-4 w-4" />} active={tab === "memory"} onClick={() => setTab("memory")} label="Memória" />
          <TabButton icon={<Settings2 className="h-4 w-4" />} active={tab === "tools"} onClick={() => setTab("tools")} label="Ferramentas" />
          <TabButton icon={<BellRing className="h-4 w-4" />} active={tab === "automation"} onClick={() => setTab("automation")} label="Automações" />
          <TabButton icon={<BarChart3 className="h-4 w-4" />} active={tab === "report"} onClick={() => setTab("report")} label="Relatório" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {tab === "summary" && (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-4">
                <SummaryCard label="Biblioteca" value={`${libraryCount}`} hint="materiais do agente" icon={<FolderOpen className="h-4 w-4 text-cyan-300" />} />
                <SummaryCard label="Memórias" value={`${memoryCount}`} hint="itens manuais" icon={<Brain className="h-4 w-4 text-violet-300" />} />
                <SummaryCard label="Proatividade" value={`${enabledAutomationCount}`} hint="regras ligadas" icon={<BellRing className="h-4 w-4 text-amber-300" />} />
                <SummaryCard label="Contexto" value={`${npc.totalTokens ?? 0}`} hint="tokens acumulados" icon={<Layers3 className="h-4 w-4 text-emerald-300" />} />
              </div>

              <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
                <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      label="Abrir chat"
                      icon={<MessageSquare className="h-4 w-4" />}
                      onClick={() => {
                        onOpenChat(npc.id, npc.name);
                        onClose();
                      }}
                    />
                    <ActionButton
                      label="Editar NPC"
                      icon={<Pencil className="h-4 w-4" />}
                      onClick={() => {
                        onEditNpc(npc.id);
                        onClose();
                      }}
                    />
                    <ActionButton
                      label="Resetar conversa"
                      icon={<RotateCcw className="h-4 w-4" />}
                      onClick={() => onResetChat(npc.id)}
                    />
                  </div>

                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <InfoBlock
                      title="Identidade"
                      content={npc.identity || "Sem identidade explícita cadastrada."}
                      onOpen={() => setExpandedInfo({
                        title: "Identidade",
                        content: npc.identity || "Sem identidade explícita cadastrada.",
                      })}
                    />
                    <InfoBlock
                      title="Soul / tom"
                      content={npc.soul || "Sem soul explícita cadastrada."}
                      onOpen={() => setExpandedInfo({
                        title: "Soul / tom",
                        content: npc.soul || "Sem soul explícita cadastrada.",
                      })}
                    />
                  </div>
                </section>

                <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <h3 className="text-sm font-semibold text-white">Conversa recente</h3>
                  <div className="mt-4 space-y-3">
                    {recentChats.length === 0 ? (
                      <EmptyPanel
                        title="Sem histórico recente"
                        description="Quando este NPC conversar com alguém, os últimos trechos aparecem aqui para consulta rápida."
                      />
                    ) : recentChats.slice(0, 4).map((message) => (
                      <div key={message.id} className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
                          <span className="font-semibold uppercase tracking-[0.18em]">
                            {message.role === "npc" ? npc.name : "Jogador"}
                          </span>
                          <span>{formatDateTime(message.createdAt)}</span>
                        </div>
                        <p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-200">{message.content}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
                <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <h3 className="text-sm font-semibold text-white">Últimas tarefas</h3>
                  <div className="mt-4 space-y-3">
                    {recentTasks.length === 0 ? (
                      <EmptyPanel
                        title="Nenhuma tarefa vinculada"
                        description="As tarefas atribuídas a este NPC vão aparecer aqui para consulta rápida."
                      />
                    ) : recentTasks.slice(0, 4).map((task) => (
                      <div key={task.id} className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium text-white">{task.title}</div>
                          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-slate-300">
                            {task.status}
                          </span>
                        </div>
                        <p className="mt-2 line-clamp-2 text-sm text-slate-400">{task.summary || "Sem resumo detalhado."}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <h3 className="text-sm font-semibold text-white">Memória de reunião</h3>
                  <div className="mt-4 space-y-3">
                    {recentMeetings.length === 0 ? (
                      <EmptyPanel
                        title="Sem reuniões relevantes"
                        description="Quando este NPC participar de uma reunião, tópicos e conclusões vão aparecer aqui."
                      />
                    ) : recentMeetings.slice(0, 3).map((meeting) => (
                      <div key={meeting.id} className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium text-white">{meeting.topic}</div>
                          <div className="text-[11px] text-slate-500">{formatDateTime(meeting.createdAt)}</div>
                        </div>
                        <p className="mt-2 text-sm text-slate-400">{meeting.conclusions || meeting.keyTopics.join(" • ") || "Sem conclusão resumida."}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          )}

          {tab === "tasks" && (
            <div className="rounded-3xl border border-white/10 bg-[#0e1526] p-2">
              <TaskPanel
                npcId={npc.id}
                npcName={npc.name}
                socket={socket}
                channelId={channelId}
                assignerCharacterId={characterId}
              />
            </div>
          )}

          {tab === "library" && (
              <div className="space-y-6">
                {/* ── Seção 1: Adicionar conhecimento + Biblioteca individual ── */}
                <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
                  <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-white">Adicionar conhecimento ao NPC</h3>
                        <p className="mt-1 text-sm text-slate-400">
                          Aqui você solta SOPs, PDFs, vídeos, exemplos de copy, snippets de código e qualquer material próprio deste agente.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="rounded-2xl border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/20"
                      >
                        <FileUp className="mr-1 inline h-4 w-4" />
                        Anexar arquivo
                      </button>
                    </div>

                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={(event) => setLibraryFile(event.target.files?.[0] ?? null)}
                    />

                    <div className="mt-5 grid gap-3 md:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Camada</span>
                        <select
                          value={libraryLayer}
                          onChange={(event) => setLibraryLayer(event.target.value)}
                          className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                        >
                          {LIBRARY_LAYER_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Categoria</span>
                        <input
                          value={libraryCategory}
                          onChange={(event) => setLibraryCategory(event.target.value)}
                          className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                          placeholder="copy, código, método, playbook..."
                        />
                      </label>
                    </div>

                    <label className="mt-3 block space-y-1">
                      <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Nome do material</span>
                      <input
                        value={libraryName}
                        onChange={(event) => setLibraryName(event.target.value)}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                        placeholder="Ex: Livro de copy, style guide, boilerplate React..."
                      />
                    </label>

                    <label className="mt-3 block space-y-1">
                      <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Conteúdo textual ou briefing do arquivo</span>
                      <textarea
                        value={libraryContent}
                        onChange={(event) => setLibraryContent(event.target.value)}
                        rows={8}
                        className="w-full resize-none rounded-2xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none"
                        placeholder="Cole aqui o conteúdo principal, uma instrução de uso do material ou um resumo para o NPC."
                      />
                    </label>

                    {libraryFile && (
                      <div className="mt-3 rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                        Arquivo pronto para envio: <span className="font-semibold">{libraryFile.name}</span>
                      </div>
                    )}

                    <div className="mt-4 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={handleCreateLibraryItem}
                        disabled={submittingLibrary || !libraryName.trim()}
                        className="rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
                      >
                        <Save className="mr-1 inline h-4 w-4" />
                        {submittingLibrary ? "Salvando..." : "Salvar na biblioteca"}
                      </button>
                      <span className="text-xs text-slate-500">A primeira versão aceita texto e arquivos leves até 2MB.</span>
                    </div>
                  </section>

                  <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-white">Biblioteca individual</h3>
                        <p className="mt-1 text-sm text-slate-400">Cada NPC guarda o próprio repertório sem misturar com o canal.</p>
                      </div>
                      <div className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-slate-300">
                        {knowledgeItems.length} item(ns)
                      </div>
                    </div>

                    {loadingLibrary ? (
                      <LoadingState label="Carregando biblioteca..." />
                    ) : knowledgeItems.length === 0 ? (
                      <div className="mt-5">
                        <EmptyPanel
                          title="Biblioteca vazia"
                          description="Adicione PDFs, vídeos, snippets, playbooks ou templates específicos deste agente."
                        />
                      </div>
                    ) : (
                      <div className="mt-5 grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
                        <div className="space-y-3 overflow-y-auto pr-1 lg:max-h-[540px]">
                          {knowledgeItems.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setSelectedLibraryId(item.id)}
                              className={`w-full rounded-2xl border p-3 text-left ${
                                selectedLibraryId === item.id
                                  ? "border-cyan-400/30 bg-cyan-500/10"
                                  : "border-white/10 bg-black/20 hover:bg-white/5"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-white">{item.name}</div>
                                  <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-slate-500">
                                    {item.layer} · {item.category}
                                  </div>
                                </div>
                                <div className="text-[11px] text-slate-500">{formatDateTime(item.updatedAt || item.createdAt)}</div>
                              </div>
                              {extractFileName(item.metadata) && (
                                <div className="mt-2 text-xs text-emerald-200">{extractFileName(item.metadata)}</div>
                              )}
                            </button>
                          ))}
                        </div>

                        <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                          {selectedLibraryItem && selectedLibraryItem.layer !== "outputs" ? (
                            <>
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-lg font-semibold text-white">{selectedLibraryItem.name}</div>
                                  <div className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-500">
                                    {selectedLibraryItem.layer} · {selectedLibraryItem.category}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteLibraryItem(selectedLibraryItem.id)}
                                  className="rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-100 hover:bg-red-500/20"
                                >
                                  <Trash2 className="mr-1 inline h-4 w-4" />
                                  Remover
                                </button>
                              </div>

                              {extractFileName(selectedLibraryItem.metadata) && (
                                <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300">
                                  Arquivo: {extractFileName(selectedLibraryItem.metadata)}
                                </div>
                              )}

                              <div className="mt-4 rounded-2xl border border-white/10 bg-[#08101d] p-4">
                                <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">
                                  {selectedLibraryItem.content || "Este item foi salvo só com metadados e arquivo base."}
                                </pre>
                              </div>
                            </>
                          ) : (
                            <EmptyPanel
                              title="Selecione um material"
                              description="Escolha um item da coluna ao lado para ver os detalhes completos."
                            />
                          )}
                        </div>
                      </div>
                    )}
                  </section>
                </div>

                {/* ── Seção 2: Artefatos criados pelo NPC ── */}
                <section className="rounded-3xl border border-violet-400/20 bg-violet-500/5 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-2xl border border-violet-400/30 bg-violet-500/20">
                        <FolderOpen className="h-4 w-4 text-violet-300" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-white">Artefatos criados pelo NPC</h3>
                        <p className="mt-0.5 text-xs text-slate-400">
                          Relatórios, designs, vídeos e arquivos que este agente gerou e entregou.
                        </p>
                      </div>
                    </div>
                    <div className="rounded-full border border-violet-400/20 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-200">
                      {outputItems.length} arquivo(s)
                    </div>
                  </div>

                  {loadingLibrary ? (
                    <LoadingState label="Carregando artefatos..." />
                  ) : outputItems.length === 0 ? (
                    <div className="mt-5 rounded-2xl border border-dashed border-white/10 px-6 py-10 text-center">
                      <FolderOpen className="mx-auto mb-3 h-8 w-8 text-slate-600" />
                      <p className="text-sm font-medium text-slate-400">Nenhum artefato salvo ainda</p>
                      <p className="mt-1 text-xs text-slate-600">
                        Quando este NPC criar um relatório, imagem, vídeo ou arquivo, ele aparecerá aqui automaticamente.
                      </p>
                    </div>
                  ) : (
                    <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {outputItems.map((item) => {
                        const meta = item.metadata as Record<string, unknown> | null;
                        const fileType = typeof meta?.fileType === "string" ? meta.fileType : "other";
                        const url = typeof meta?.url === "string" ? meta.url : null;
                        const description = typeof meta?.description === "string" ? meta.description : null;
                        const clientName = typeof meta?.clientName === "string" ? meta.clientName : null;
                        const savedAt = typeof meta?.savedAt === "string" ? meta.savedAt : item.createdAt;
                        const tags = Array.isArray(meta?.tags) ? (meta.tags as string[]) : [];

                        return (
                          <div
                            key={item.id}
                            className={`group relative flex flex-col gap-3 rounded-2xl border p-4 ${outputFileBg(fileType)}`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-black/20">
                                {outputFileIcon(fileType)}
                              </div>
                              <button
                                type="button"
                                onClick={() => handleDeleteLibraryItem(item.id)}
                                className="hidden rounded-lg border border-red-400/20 bg-red-500/10 p-1.5 text-red-300 hover:bg-red-500/20 group-hover:flex"
                                title="Remover"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold text-white" title={item.name}>
                                {item.name}
                              </div>
                              {description && (
                                <p className="mt-1 line-clamp-2 text-xs text-slate-400">{description}</p>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded-md border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                                {fileType}
                              </span>
                              {clientName && (
                                <span className="rounded-md border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] text-slate-400">
                                  {clientName}
                                </span>
                              )}
                              {tags.slice(0, 2).map((tag) => (
                                <span key={tag} className="rounded-md border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] text-slate-500">
                                  #{tag}
                                </span>
                              ))}
                            </div>

                            <div className="flex items-center justify-between gap-2 border-t border-white/5 pt-2">
                              <span className="text-[10px] text-slate-600">
                                {savedAt ? formatDateTime(savedAt) : "—"}
                              </span>
                              {url ? (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-white/10"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  Abrir
                                </a>
                              ) : (
                                <span className="text-[10px] text-slate-600">sem URL</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
          )}

          {tab === "memory" && (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-3">
                <SummaryCard label="1ª camada" value={`${memoryData?.memoryLayers.firstLayer ?? 0}`} hint="episódica / trabalho" icon={<Brain className="h-4 w-4 text-pink-300" />} />
                <SummaryCard label="2ª camada" value={`${memoryData?.memoryLayers.secondLayer ?? 0}`} hint="resumos / relações" icon={<Layers3 className="h-4 w-4 text-violet-300" />} />
                <SummaryCard label="Longo prazo" value={`${memoryData?.memoryLayers.longTerm ?? 0}`} hint="fatos fixados" icon={<Sparkles className="h-4 w-4 text-cyan-300" />} />
              </div>

              <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
                <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <h3 className="text-sm font-semibold text-white">Adicionar memória manual</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    Use este bloco para travar fatos, resumos e aprendizados que o NPC não pode perder.
                  </p>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <label className="space-y-1">
                      <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Tipo</span>
                      <select
                        value={memoryType}
                        onChange={(event) => setMemoryType(event.target.value)}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                      >
                        {MEMORY_TYPE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Título</span>
                      <input
                        value={memoryTitle}
                        onChange={(event) => setMemoryTitle(event.target.value)}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                        placeholder="Ex: Cliente prefere copy direta"
                      />
                    </label>
                  </div>

                  <label className="mt-3 block space-y-1">
                    <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Conteúdo da memória</span>
                    <textarea
                      value={memoryContent}
                      onChange={(event) => setMemoryContent(event.target.value)}
                      rows={6}
                      className="w-full resize-none rounded-2xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none"
                      placeholder="Ex: Sempre que falar com a Will, lembrar que ela gosta de respostas objetivas e orientadas à ação."
                    />
                  </label>

                  <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={memoryPinned}
                      onChange={(event) => setMemoryPinned(event.target.checked)}
                    />
                    Fixar na camada principal
                  </label>

                  <button
                    type="button"
                    onClick={handleCreateMemory}
                    disabled={submittingMemory || !memoryTitle.trim() || !memoryContent.trim()}
                    className="mt-4 rounded-2xl bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50"
                  >
                    <Save className="mr-1 inline h-4 w-4" />
                    {submittingMemory ? "Salvando..." : "Salvar memória"}
                  </button>
                </section>


                <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <h3 className="text-sm font-semibold text-white">Hub de Memória</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    Memórias organizadas por categoria para consulta rápida e gestão.
                  </p>

                  <div className="mt-6 grid grid-cols-2 gap-4">
                    {Object.entries(categoryMetadata).map(([key, meta]) => {
                      const count = (memoryByCategory[key] || []).length;
                      return (
                        <button
                          key={key}
                          onClick={() => setSelectedMemoryCategory(key)}
                          className="flex flex-col items-center justify-center rounded-3xl border border-white/10 bg-black/20 p-6 transition hover:border-cyan-400/30 hover:bg-black/40"
                        >
                          <div className={`rounded-2xl bg-white/5 p-3 ${meta.color}`}>{meta.icon}</div>
                          <div className="mt-3 text-sm font-semibold text-white">{meta.label}</div>
                          <div className="mt-1 text-xs text-slate-500">{count} itens</div>
                        </button>
                      );
                    })}
                  </div>
                </section>

              </div>

              <div className="grid gap-6 xl:grid-cols-3">
                <DerivedMemorySection
                  title="Conversas recentes"
                  description="Trechos da conversa para o NPC nunca perder o fio."
                  items={recentChats.map((message) => ({
                    id: message.id,
                    title: message.role === "npc" ? npc.name : "Jogador",
                    subtitle: formatDateTime(message.createdAt),
                    content: message.content,
                  }))}
                />
                <DerivedMemorySection
                  title="Tarefas e progresso"
                  description="Estado operacional atual do agente."
                  items={recentTasks.map((task) => ({
                    id: task.id,
                    title: task.title,
                    subtitle: `${task.status} · ${formatDateTime(task.updatedAt)}`,
                    content: task.summary || "Sem resumo adicional.",
                  }))}
                />
                <DerivedMemorySection
                  title="Reuniões relevantes"
                  description="Tópicos e conclusões onde este NPC apareceu."
                  items={recentMeetings.map((meeting) => ({
                    id: meeting.id,
                    title: meeting.topic,
                    subtitle: formatDateTime(meeting.createdAt),
                    content: meeting.conclusions || meeting.keyTopics.join(" • ") || meeting.transcript.slice(0, 240),
                  }))}
                />
              </div>
            </div>
          )}

          {tab === "tools" && (
            <div className="space-y-5">
              <ToolsAutoConfigPanel npcId={npc.id} npcName={npc.name} hasAgent={npc.hasAgent ?? false} />
              <div className="rounded-3xl border border-white/10 bg-[#0d1426] p-2">
                <NpcKeysTab npcId={npc.id} />
              </div>
            </div>
          )}

          {tab === "automation" && (
            <div className="space-y-6">
              <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Comportamento proativo</h3>
                    <p className="mt-1 text-sm text-slate-400">
                      Configure briefings, recapitulações, batimentos e consolidação de memória de forma individual para cada NPC.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleSaveAutomations}
                    disabled={savingAutomation}
                    className="rounded-2xl bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-300 disabled:opacity-50"
                  >
                    <Wand2 className="mr-1 inline h-4 w-4" />
                    {savingAutomation ? "Salvando..." : "Salvar regras"}
                  </button>
                </div>
              </div>

              {loadingAutomation ? (
                <LoadingState label="Carregando automações..." />
              ) : (
                <div className="grid gap-4 xl:grid-cols-2">
                  {automationRules.map((rule, index) => (
                    <div key={rule.id} className="rounded-3xl border border-white/10 bg-white/5 p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h4 className="text-lg font-semibold text-white">{rule.title}</h4>
                          <p className="mt-1 text-sm leading-6 text-slate-400">{rule.description}</p>
                        </div>
                        <label className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-2 text-sm text-white">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={(event) => {
                              setAutomationRules((current) => current.map((item, itemIndex) => (
                                itemIndex === index ? { ...item, enabled: event.target.checked } : item
                              )));
                            }}
                          />
                          Ativar
                        </label>
                      </div>

                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <label className="space-y-1">
                          <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Agendamento</span>
                          <select
                            value={rule.schedule}
                            onChange={(event) => {
                              const nextSchedule = event.target.value as AutomationRule["schedule"];
                              setAutomationRules((current) => current.map((item, itemIndex) => (
                                itemIndex === index ? { ...item, schedule: nextSchedule } : item
                              )));
                            }}
                            className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                          >
                            <option value="manual">Manual</option>
                            <option value="daily">Diário</option>
                            <option value="event">Por evento</option>
                          </select>
                        </label>

                        {rule.schedule === "daily" ? (
                          <label className="space-y-1">
                            <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Horário</span>
                            <input
                              type="time"
                              value={rule.time || "09:00"}
                              onChange={(event) => {
                                setAutomationRules((current) => current.map((item, itemIndex) => (
                                  itemIndex === index ? { ...item, time: event.target.value } : item
                                )));
                              }}
                              className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </label>
                        ) : (
                          <label className="space-y-1">
                            <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Gatilho</span>
                            <input
                              value={rule.trigger || ""}
                              onChange={(event) => {
                                setAutomationRules((current) => current.map((item, itemIndex) => (
                                  itemIndex === index ? { ...item, trigger: event.target.value } : item
                                )));
                              }}
                              placeholder="task-change, memory-save, manual..."
                              className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                            />
                          </label>
                        )}
                      </div>

                      <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-300">
                        <Clock3 className="mr-2 inline h-4 w-4 text-amber-300" />
                        {rule.schedule === "daily"
                          ? `Executa diariamente por volta de ${rule.time || "09:00"}`
                          : rule.schedule === "event"
                            ? `Escuta gatilho: ${rule.trigger || "manual"}`
                            : "Mantido como rotina manual por enquanto"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "report" && (
            <div className="space-y-6">
              {/* [A] Config LLM — escolhe modelo mais barato direto aqui */}
              <section className="rounded-3xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 to-violet-500/5 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      <Settings2 className="mr-1 inline h-4 w-4 text-cyan-300" />
                      Modelo de IA deste NPC
                    </h3>
                    <p className="mt-1 text-sm text-slate-400">
                      Escolha qual provedor/modelo esse NPC usa. Dica: trocar pra Haiku, GPT-4o-mini ou Groq pode reduzir custos em 10-50x.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleSaveLlmConfig}
                    disabled={savingLlm}
                    className="rounded-2xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:opacity-50"
                  >
                    <Save className="mr-1 inline h-4 w-4" />
                    {savingLlm ? "Salvando..." : "Salvar LLM"}
                  </button>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Provider</span>
                    <select
                      value={llmProvider}
                      onChange={(event) => {
                        setLlmProvider(event.target.value);
                        const first = LLM_MODELS[event.target.value]?.[0]?.value ?? "";
                        setLlmModel(first);
                      }}
                      className="w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none"
                    >
                      {LLM_PROVIDERS.map((provider) => (
                        <option key={provider.value} value={provider.value}>{provider.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Modelo</span>
                    {(LLM_MODELS[llmProvider]?.length ?? 0) > 0 ? (
                      <select
                        value={llmModel}
                        onChange={(event) => setLlmModel(event.target.value)}
                        className="w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none"
                      >
                        <option value="">— automático —</option>
                        {LLM_MODELS[llmProvider].map((model) => (
                          <option key={model.value} value={model.value}>
                            {model.label} · {model.cost}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={llmModel}
                        onChange={(event) => setLlmModel(event.target.value)}
                        placeholder="Usa o padrão do gateway"
                        className="w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none"
                      />
                    )}
                  </label>
                </div>

                <div className="mt-3 text-xs text-slate-500">
                  💡 Preços indicados por 1M tokens (input / output). Gateways locais (Claude Code, Codex, OpenClaw) não contam na sua API key pessoal.
                </div>
              </section>

              {/* [B] Range selector */}
              <div className="flex items-center gap-2">
                {(["today", "7d", "30d", "all"] as const).map((range) => (
                  <button
                    key={range}
                    type="button"
                    onClick={() => setUsageRange(range)}
                    className={`rounded-full border px-4 py-1.5 text-xs font-medium transition-colors ${
                      usageRange === range
                        ? "border-cyan-400/30 bg-cyan-500/15 text-cyan-100"
                        : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
                    }`}
                  >
                    {range === "today" ? "Hoje" : range === "7d" ? "7 dias" : range === "30d" ? "30 dias" : "Tudo"}
                  </button>
                ))}
                <div className="ml-auto text-xs text-slate-500">
                  {loadingUsage ? "Carregando..." : usageReport ? `${usageReport.totals.count} registros` : ""}
                </div>
              </div>

              {loadingUsage && !usageReport ? (
                <LoadingState label="Carregando relatório..." />
              ) : !usageReport || usageReport.totals.count === 0 ? (
                <EmptyPanel
                  title="Sem uso registrado"
                  description="Quando este NPC processar mensagens, tarefas, reuniões ou chamar ferramentas, o consumo de tokens vai aparecer aqui."
                />
              ) : (
                <>
                  {/* [C] Totais */}
                  <div className="grid gap-4 md:grid-cols-4">
                    <SummaryCard
                      label="Tokens"
                      value={formatNumber(usageReport.totals.tokens)}
                      hint={`${formatNumber(usageReport.totals.promptTokens)} in · ${formatNumber(usageReport.totals.completionTokens)} out`}
                      icon={<Layers3 className="h-4 w-4 text-cyan-300" />}
                    />
                    <SummaryCard
                      label="Custo estimado"
                      value={formatCost(usageReport.totals.cost)}
                      hint="soma do período"
                      icon={<DollarSign className="h-4 w-4 text-emerald-300" />}
                    />
                    <SummaryCard
                      label="Chamadas"
                      value={`${usageReport.totals.count}`}
                      hint="requisições registradas"
                      icon={<BarChart3 className="h-4 w-4 text-violet-300" />}
                    />
                    <SummaryCard
                      label="Última atividade"
                      value={formatDateTime(usageReport.totals.lastAt)}
                      hint={`total do NPC: ${formatNumber(usageReport.totals.npcTotalTokensCached)}`}
                      icon={<Clock3 className="h-4 w-4 text-amber-300" />}
                    />
                  </div>

                  {/* [D] Breakdown por tipo de operação */}
                  <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                    <h3 className="text-sm font-semibold text-white">Por tipo de operação</h3>
                    <p className="mt-1 text-sm text-slate-400">
                      Quanto cada atividade consome: conversa direta, tarefas, reuniões, automações e chamadas de ferramenta.
                    </p>
                    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {Object.entries(usageReport.byKind).length === 0 ? (
                        <div className="col-span-full text-sm text-slate-500">Nenhum registro ainda.</div>
                      ) : Object.entries(usageReport.byKind).map(([kind, data]) => {
                        const meta = kindMeta(kind);
                        return (
                          <div key={kind} className={`rounded-2xl border p-4 ${meta.bg}`}>
                            <div className={`text-xs font-semibold uppercase tracking-[0.18em] ${meta.color}`}>
                              {meta.label}
                            </div>
                            <div className="mt-2 text-2xl font-semibold text-white">
                              {formatNumber(data.tokens)}
                            </div>
                            <div className="mt-1 text-xs text-slate-400">
                              {formatCost(data.cost)} · {data.count} chamadas
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  {/* [E] Provider breakdown */}
                  {usageReport.byProvider.length > 0 && (
                    <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                      <h3 className="text-sm font-semibold text-white">Por provider</h3>
                      <div className="mt-4 space-y-2">
                        {usageReport.byProvider.map((row) => (
                          <div key={row.provider} className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm">
                            <span className="font-medium text-white">{formatProvider(row.provider)}</span>
                            <div className="flex gap-4 text-slate-300">
                              <span>{formatNumber(row.tokens)} tokens</span>
                              <span>{formatCost(row.cost)}</span>
                              <span className="text-slate-500">{row.count} calls</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* [F] Top tools */}
                  {usageReport.topTools.length > 0 && (
                    <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                      <h3 className="text-sm font-semibold text-white">Ferramentas mais chamadas</h3>
                      <div className="mt-4 space-y-2">
                        {usageReport.topTools.map((tool, idx) => (
                          <div key={tool.toolName ?? idx} className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm">
                            <span className="font-mono text-rose-200">{tool.toolName || "—"}</span>
                            <div className="flex gap-4 text-slate-300">
                              <span>{formatNumber(tool.tokens)} tokens</span>
                              <span>{formatCost(tool.cost)}</span>
                              <span className="text-slate-500">{tool.count}x</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* [G] Timeline recente */}
                  <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                    <h3 className="text-sm font-semibold text-white">Últimas execuções</h3>
                    <div className="mt-4 space-y-2">
                      {usageReport.recentLogs.slice(0, 25).map((log) => {
                        const meta = kindMeta(log.contextKind);
                        const costNum = typeof log.estimatedCost === "string" ? parseFloat(log.estimatedCost) : log.estimatedCost;
                        return (
                          <div key={log.id} className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${meta.bg} ${meta.color}`}>
                                  {meta.label}
                                </span>
                                <span className="text-white">{log.label || log.toolName || "—"}</span>
                                {log.isRealUsage ? (
                                  <span className="rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-200">Real</span>
                                ) : (
                                  <span className="rounded-full border border-slate-400/30 bg-slate-500/15 px-2 py-0.5 text-[10px] text-slate-300">Estimado</span>
                                )}
                              </div>
                              <div className="flex gap-3 text-xs text-slate-400">
                                <span>{formatNumber((log.promptTokens || 0) + (log.completionTokens || 0))}t</span>
                                <span>{formatCost(costNum || 0)}</span>
                                {log.durationMs ? <span>{(log.durationMs / 1000).toFixed(1)}s</span> : null}
                                <span>{formatDateTime(log.createdAt)}</span>
                              </div>
                            </div>
                            {(log.model || log.provider) && (
                              <div className="mt-1 text-[11px] text-slate-500">
                                {log.provider ? formatProvider(log.provider) : ""}{log.provider && log.model ? " · " : ""}{log.model || ""}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </>
              )}
            </div>
          )}
        </div>

        {expandedInfo && (
          <div
            className="absolute inset-0 z-[90] flex items-center justify-center bg-black/75 px-6 py-8"
            onClick={() => setExpandedInfo(null)}
          >
            <div
              className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-[28px] border border-white/10 bg-[#0b1325] shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.26em] text-cyan-300/80">Conteudo completo</div>
                  <h3 className="mt-1 text-xl font-semibold text-white">{expandedInfo.title}</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setExpandedInfo(null)}
                  className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 hover:bg-white/10 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="overflow-y-auto px-6 py-5">
                <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-slate-200">
                  {expandedInfo.content}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Memory Details Modal */}
      {selectedMemoryCategory && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-[2.5rem] border border-white/10 bg-[#0f172a] shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/5 px-8 py-6">
              <div className="flex items-center gap-3">
                <div className={`rounded-2xl bg-white/5 p-2 ${categoryMetadata[selectedMemoryCategory]?.color}`}>
                  {categoryMetadata[selectedMemoryCategory]?.icon}
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white">{categoryMetadata[selectedMemoryCategory]?.label}</h2>
                  <p className="text-xs text-slate-400">Gerencie os registros desta categoria</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedMemoryCategory(null)}
                className="rounded-2xl bg-white/5 p-2 text-slate-400 hover:bg-white/10 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto px-8 py-6 space-y-4">
              {(memoryByCategory[selectedMemoryCategory] || []).length === 0 ? (
                <EmptyPanel title="Vazio" description="Nenhum item nesta categoria ainda." />
              ) : (
                memoryByCategory[selectedMemoryCategory].map((item: any) => (
                  <div key={item.id} className="rounded-3xl border border-white/10 bg-white/5 p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="text-sm font-bold text-white">{item.title}</div>
                        <div className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">{new Date(item.createdAt).toLocaleString()}</div>
                      </div>
                      <button
                        onClick={() => handleDeleteMemory(item.id)}
                        className="rounded-xl border border-red-500/20 bg-red-500/10 p-2 text-red-300 hover:bg-red-500/20"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <p className="mt-4 text-sm leading-relaxed text-slate-300 whitespace-pre-wrap">{item.content}</p>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-white/5 px-8 py-6 bg-black/20">
               <button
                onClick={() => setSelectedMemoryCategory(null)}
                className="w-full rounded-2xl bg-white/10 py-3 text-sm font-semibold text-white hover:bg-white/15"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// Painel de auto-configuração de MCPs por papel do NPC
function ToolsAutoConfigPanel({ npcId, npcName, hasAgent }: { npcId: string; npcName: string; hasAgent: boolean }) {
  const [supabaseToken, setSupabaseToken] = useState("");
  const [configuring, setConfiguring] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; role?: string } | null>(null);

  const handleAutoConfig = async () => {
    setConfiguring(true);
    setResult(null);
    try {
      const res = await fetch(`/api/npcs/${npcId}/setup-role`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supabaseAccessToken: supabaseToken }),
      });
      const data = await res.json();
      setResult({
        ok: res.ok,
        message: data.message || (res.ok ? "Configurado!" : data.error || "Erro"),
        role: data.role,
      });
    } catch {
      setResult({ ok: false, message: "Erro de rede" });
    } finally {
      setConfiguring(false);
    }
  };

  return (
    <div className="rounded-3xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/10 to-slate-900/10 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-white">
            <Sparkles className="mr-1 inline h-4 w-4 text-emerald-300" />
            Auto-configurar ferramentas
          </h3>
          <p className="mt-1 text-sm text-slate-400">
            Detecta o papel de <span className="text-white font-medium">{npcName}</span> e configura MCPs, tools e prompt automaticamente.
            {!hasAgent && <span className="ml-1 text-amber-400">(MCPs salvos, mas IDENTITY.md requer agente vinculado)</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={handleAutoConfig}
          disabled={configuring}
          className="shrink-0 rounded-2xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300 disabled:opacity-50"
        >
          <Wand2 className="mr-1 inline h-4 w-4" />
          {configuring ? "Configurando..." : "Auto-configurar"}
        </button>
      </div>

      <div className="mt-4 space-y-2">
        <label className="block space-y-1">
          <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
            Supabase Access Token <span className="text-slate-600">(opcional — configura acesso ao banco)</span>
          </span>
          <div className="flex gap-2">
            <input
              type="password"
              value={supabaseToken}
              onChange={(e) => setSupabaseToken(e.target.value)}
              placeholder="sbp_xxxxxxxxxxxxxxxxxxxx"
              className="flex-1 rounded-2xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white outline-none placeholder:text-slate-600"
            />
          </div>
          <p className="text-[11px] text-slate-500">
            Supabase Dashboard → Clique no seu avatar → Access Tokens → Generate new token
          </p>
        </label>
      </div>

      {result && (
        <div className={`mt-3 rounded-2xl border px-4 py-3 text-sm ${result.ok ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200" : "border-red-400/30 bg-red-500/10 text-red-200"}`}>
          {result.role && <span className="mr-2 rounded-full border border-white/10 bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider">{result.role}</span>}
          {result.message}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-cyan-400/30 bg-cyan-500/15 text-cyan-100"
          : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
          <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
          <div className="mt-1 text-xs text-slate-400">{hint}</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">{icon}</div>
      </div>
    </div>
  );
}

function InfoBlock({
  title,
  content,
  onOpen,
}: {
  title: string;
  content: string;
  onOpen?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-[260px] w-full flex-col rounded-3xl border border-white/10 bg-black/20 p-4 text-left transition hover:border-cyan-400/30 hover:bg-black/30"
    >
      <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">{title}</div>
      <p className="mt-3 line-clamp-8 whitespace-pre-wrap text-sm leading-6 text-slate-200">{content}</p>
      <div className="mt-auto flex items-center justify-between pt-4">
        <span className="text-xs text-slate-500">Previa resumida</span>
        <span className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-100">
          Ver completo
        </span>
      </div>
    </button>
  );
}

function ActionButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-white/10"
    >
      {icon}
      <span className="ml-2">{label}</span>
    </button>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-white/10 bg-black/10 px-5 py-8 text-center">
      <Bot className="mx-auto h-8 w-8 text-slate-500" />
      <h4 className="mt-3 text-sm font-semibold text-white">{title}</h4>
      <p className="mt-1 text-sm leading-6 text-slate-400">{description}</p>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="rounded-3xl border border-white/10 bg-black/20 px-5 py-8 text-center text-sm text-slate-300">
      {label}
    </div>
  );
}

function DerivedMemorySection({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items: Array<{ id: string; title: string; subtitle: string; content: string }>;
}) {
  return (
    <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <p className="mt-1 text-sm text-slate-400">{description}</p>
      <div className="mt-4 space-y-3">
        {items.length === 0 ? (
          <EmptyPanel
            title="Nada por aqui ainda"
            description="Assim que o NPC ganhar histórico nesta camada, os registros aparecem nesta coluna."
          />
        ) : items.map((item) => (
          <div key={item.id} className="rounded-2xl border border-white/10 bg-black/20 p-3">
            <div className="text-sm font-medium text-white">{item.title}</div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">{item.subtitle}</div>
            <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-slate-200">{item.content}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
