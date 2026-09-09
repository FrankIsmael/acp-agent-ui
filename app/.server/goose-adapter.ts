/** Extensiones opcionales de Goose/Ghosty: el historial normal sigue siendo ACP. */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
  type: "skill" | "builtinSkill";
}
export function parseSkills(response: unknown): AgentSkill[] {
  const sources = (response as { sources?: unknown[] } | null)?.sources;
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((item): AgentSkill[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    const type = source.type ?? source.sourceType;
    if (type !== "skill" && type !== "builtinSkill") return [];
    const text = (key: string) => typeof source[key] === "string" ? source[key] as string : "";
    return [{ id: text("id") || text("path") || text("name"), name: text("name"), description: text("description"), path: text("path"), content: text("content"), type }];
  });
}
export function replayMetadata(agentName: string, tail: number | undefined) {
  return /^(goose|ghosty-lite)$/.test(agentName) && tail && Number.isSafeInteger(tail) && tail > 0
    ? { _meta: { replayTail: tail } } : {};
}
