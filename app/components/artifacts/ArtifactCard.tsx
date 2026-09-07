import { ArrowUpRight, Code2, FileText, Globe, Image } from "lucide-react";
import { previewKind, type ParsedArtifact } from "~/lib/artifacts";
import { useArtifacts } from "./ArtifactContext";

export function ArtifactCard({ artifact, artifactKey, streaming = false }: { artifact: ParsedArtifact; artifactKey: string; streaming?: boolean }) {
  const { open } = useArtifacts();
  const kind = previewKind(artifact);
  const Icon = kind === "html" ? Globe : kind === "svg" ? Image : kind === "code" ? Code2 : FileText;
  return (
    <button onClick={() => open(artifactKey)} className="my-3 flex w-full min-w-0 items-center gap-3 rounded-xl border border-border-secondary bg-background-primary p-4 text-left shadow-xs transition-colors hover:bg-background-secondary focus-visible:outline-2 focus-visible:outline-border-primary">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border-secondary bg-background-secondary"><Icon className="h-5 w-5" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{artifact.title}</span>
        <span className="block text-xs text-text-secondary">{streaming ? "Creando…" : "Abrir artifact"} · {artifact.language || kind}</span>
      </span>
      <ArrowUpRight className="h-4 w-4 shrink-0 text-text-tertiary" />
    </button>
  );
}
