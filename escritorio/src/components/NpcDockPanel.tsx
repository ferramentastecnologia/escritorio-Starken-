"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { Bot, Brain, ChevronDown, MessageSquare, Pencil, Plus, Search, Settings2, Sparkles } from "lucide-react";
import RosterAvatar from "@/components/RosterAvatar";
import type { CharacterAppearance, LegacyCharacterAppearance } from "@/lib/lpc-registry";

export interface NpcDockRecord {
  id: string;
  name: string;
  appearance?: unknown;
  runtimeProvider?: string | null;
  model?: string | null;
  hasAgent?: boolean;
  totalTokens?: number;
  automationRules?: unknown[];
}

interface NpcDockPanelProps {
  channelName: string;
  npcs: NpcDockRecord[];
  selectedNpcId?: string | null;
  onManageNpc: (npcId: string) => void;
  onTalkToNpc: (npcId: string, npcName: string) => void;
  onEditNpc: (npcId: string) => void;
  onHireNpc?: () => void;
}

function getProviderLabel(provider?: string | null) {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex") return "Codex";
  if (provider === "openclaw") return "OpenClaw";
  return "Canal";
}

function getProviderClass(provider?: string | null) {
  if (provider === "claude-code") return "border-orange-400/30 bg-orange-500/10 text-orange-200";
  if (provider === "codex") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-200";
  if (provider === "openclaw") return "border-sky-400/30 bg-sky-500/10 text-sky-200";
  return "border-white/10 bg-white/5 text-text-secondary";
}

function countEnabledRules(rules: unknown[] | undefined): number {
  if (!Array.isArray(rules)) return 0;
  return rules.filter((rule) => {
    if (!rule || typeof rule !== "object") return false;
    return Boolean((rule as { enabled?: boolean }).enabled);
  }).length;
}

export default function NpcDockPanel({
  channelName,
  npcs,
  selectedNpcId,
  onManageNpc,
  onTalkToNpc,
  onEditNpc,
  onHireNpc,
}: NpcDockPanelProps) {
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);

  const filteredNpcs = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase();
    if (!normalized) return npcs;
    return npcs.filter((npc) => {
      const provider = getProviderLabel(npc.runtimeProvider).toLowerCase();
      const model = (npc.model || "").toLowerCase();
      return npc.name.toLowerCase().includes(normalized) || provider.includes(normalized) || model.includes(normalized);
    });
  }, [deferredQuery, npcs]);

  const toggleExpanded = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-30 hidden w-[260px] lg:flex">
      <div className="flex h-full w-full flex-col overflow-hidden border-l border-white/10 bg-[#0d1222]/92 shadow-2xl backdrop-blur-xl">
        {/* Header enxuto */}
        <div className="border-b border-white/10 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300/80">
                Agentes
              </div>
              <p className="mt-0.5 truncate text-[11px] text-slate-400">{channelName}</p>
            </div>
            <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-slate-300">
              {npcs.length}
            </span>
          </div>

          {onHireNpc && (
            <button
              type="button"
              onClick={onHireNpc}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-cyan-500/15 px-3 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-500/25"
            >
              <Plus className="h-3.5 w-3.5" />
              Contratar NPC
            </button>
          )}

          <label className="mt-2 flex items-center gap-1.5 rounded-xl border border-white/10 bg-black/20 px-2.5 py-1.5 text-xs text-slate-300">
            <Search className="h-3.5 w-3.5 text-slate-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar"
              className="w-full bg-transparent text-xs text-white outline-none placeholder:text-slate-500"
            />
          </label>
        </div>

        {/* Lista compacta */}
        <div className="flex-1 overflow-y-auto px-1.5 py-2">
          {filteredNpcs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-black/10 px-4 text-center">
              <Bot className="h-7 w-7 text-slate-500" />
              <h3 className="mt-2 text-xs font-semibold text-white">Nenhum agente</h3>
              <p className="mt-1 text-[11px] leading-4 text-slate-400">
                Ajuste a busca ou contrate um NPC.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {filteredNpcs.map((npc) => {
                const provider = getProviderLabel(npc.runtimeProvider);
                const model = npc.model?.trim() || "Padrão do canal";
                const automationCount = countEnabledRules(npc.automationRules);
                const isExpanded = expandedId === npc.id;
                const isSelected = selectedNpcId === npc.id;

                return (
                  <div
                    key={npc.id}
                    className={`rounded-xl border transition-all ${
                      isSelected
                        ? "border-cyan-400/40 bg-cyan-500/10"
                        : isExpanded
                        ? "border-white/15 bg-white/5"
                        : "border-transparent hover:border-white/10 hover:bg-white/5"
                    }`}
                  >
                    {/* Linha compacta */}
                    <button
                      type="button"
                      onClick={() => toggleExpanded(npc.id)}
                      className="flex w-full items-center gap-2.5 px-2 py-1.5 text-left"
                    >
                      <RosterAvatar
                        appearance={(npc.appearance as CharacterAppearance | LegacyCharacterAppearance | null) ?? null}
                        size={32}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-white">{npc.name}</span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                      />
                    </button>

                    {/* Accordion expandido */}
                    {isExpanded && (
                      <div className="border-t border-white/5 px-2.5 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${getProviderClass(npc.runtimeProvider)}`}>
                            {provider}
                          </span>
                          <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] text-slate-300">
                            {model}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] text-slate-300">
                            <Sparkles className="h-3 w-3 text-cyan-300" />
                            {npc.hasAgent ? "Agente" : "Sem agente"}
                          </span>
                        </div>

                        <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px]">
                          <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                            <div className="text-slate-500">Memória</div>
                            <div className="mt-0.5 flex items-center gap-1 font-medium text-white">
                              <Brain className="h-3 w-3 text-violet-300" />
                              {npc.totalTokens ?? 0} tok
                            </div>
                          </div>
                          <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                            <div className="text-slate-500">Regras</div>
                            <div className="mt-0.5 font-medium text-white">{automationCount} ativas</div>
                          </div>
                        </div>

                        <div className="mt-2.5 grid grid-cols-3 gap-1">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onTalkToNpc(npc.id, npc.name);
                            }}
                            className="flex items-center justify-center gap-1 rounded-lg bg-cyan-500/15 px-2 py-1.5 text-[10px] font-semibold text-cyan-100 hover:bg-cyan-500/25"
                            title="Abrir chat"
                          >
                            <MessageSquare className="h-3 w-3" />
                            Chat
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onManageNpc(npc.id);
                            }}
                            className="flex items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[10px] font-semibold text-slate-200 hover:bg-white/10"
                            title="Command Center"
                          >
                            <Settings2 className="h-3 w-3" />
                            Gerir
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onEditNpc(npc.id);
                            }}
                            className="flex items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[10px] font-semibold text-slate-200 hover:bg-white/10"
                            title="Editar"
                          >
                            <Pencil className="h-3 w-3" />
                            Editar
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
