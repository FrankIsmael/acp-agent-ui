import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Code2, Copy, Download, Eye, Maximize2, Minimize2, RotateCcw, Share2, X } from "lucide-react";
import { artifactContent, artifactFile, artifactPreviewDocument, previewKind, type Artifact } from "~/lib/artifacts";
import { Button } from "~/components/ui/button";
import { Markdown } from "~/components/Markdown";
import { useArtifacts } from "./ArtifactContext";

function downloadArtifact(artifact: Artifact) {
  const file = artifactFile(artifact);
  const url = URL.createObjectURL(new Blob([artifactContent(artifact)], { type: `${file.mime};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function PanelContent({ artifact, artifacts, expanded, onExpand, streaming, mode, setMode }: {
  artifact: Artifact; artifacts: Artifact[]; expanded: boolean; onExpand: () => void; streaming: boolean;
  mode: "preview" | "code"; setMode: (mode: "preview" | "code") => void;
}) {
  const { edit, close, open, saveStatus } = useArtifacts();
  const kind = previewKind(artifact);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const content = artifactContent(artifact);
  const [preview, setPreview] = useState(content);
  const latestContent = useRef(content);
  useEffect(() => { latestContent.current = content; }, [content]);
  // Refresh at most four times/second; a trailing-only debounce never renders
  // while a fast token stream is still arriving.
  useEffect(() => {
    const timer = window.setInterval(() => setPreview(latestContent.current), 250);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(content); setNotice("Copiado"); }
    catch { setNotice("No se pudo copiar. Selecciona el texto en Código o descarga el archivo."); }
  };
  const share = async () => {
    const { name, mime } = artifactFile(artifact);
    const file = new File([content], name, { type: mime });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: artifact.title, files: [file] });
      } else {
        downloadArtifact(artifact);
        setNotice("Archivo descargado para compartir.");
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) setNotice("No se pudo compartir. Puedes descargar el archivo.");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background-primary text-text-primary">
      <header className="flex min-w-0 items-center gap-2 border-b border-border-secondary px-3 py-2">
        <div className="min-w-0 flex-1">
          <label className="sr-only" htmlFor="artifact-selector">Artifact activo</label>
          <select id="artifact-selector" className="w-full truncate bg-background-primary py-1 text-sm font-medium" value={artifact.key} onChange={e => open(e.target.value)}>
            {artifacts.map(a => <option key={a.key} value={a.key}>{a.title} · {a.language || previewKind(a)} · #{a.turnIndex + 1}</option>)}
          </select>
        </div>
        <Button variant="ghost" size="sm" shape="round" onClick={onExpand} aria-label={expanded ? "Reducir panel" : "Ampliar panel"} title={expanded ? "Reducir panel" : "Ampliar panel"}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button>
        <Button variant="ghost" size="sm" shape="round" onClick={close} aria-label="Cerrar artifacts" title="Cerrar artifacts"><X /></Button>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-secondary px-3 py-2">
        <div className="flex gap-1" aria-label="Vista del artifact">
          <Button size="xs" variant={mode === "preview" ? "secondary" : "ghost"} disabled={kind === "code"} aria-pressed={mode === "preview"} onClick={() => setMode("preview")}><Eye />Vista previa</Button>
          <Button size="xs" variant={mode === "code" ? "secondary" : "ghost"} aria-pressed={mode === "code"} onClick={() => setMode("code")}><Code2 />{kind === "markdown" || kind === "text" ? "Editar" : "Código"}</Button>
        </div>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={copy} aria-label="Copiar contenido" title="Copiar contenido"><Copy /></Button>
          <Button size="xs" variant="ghost" onClick={() => downloadArtifact(artifact)} aria-label="Descargar archivo" title="Descargar archivo"><Download /></Button>
          <Button size="xs" variant="ghost" onClick={share} aria-label="Compartir archivo" title="Compartir archivo"><Share2 /></Button>
          <Button size="xs" variant="ghost" onClick={() => setRevision(v => v + 1)} aria-label="Reiniciar vista previa" title="Reiniciar vista previa" disabled={mode !== "preview" || !["html", "svg"].includes(kind)}><RotateCcw /></Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {mode === "code" ? (
          <div className="flex h-full flex-col">
            {kind === "code" && <p className="border-b border-border-secondary px-4 py-2 text-xs text-text-secondary">Código editable. La vista previa ejecuta apps HTML con CSS y JavaScript incluidos.</p>}
            <textarea aria-label={`Editar ${artifact.title}`} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={content} readOnly={streaming}
              onChange={e => edit(artifact.key, e.target.value)}
              className="min-h-0 w-full flex-1 resize-none bg-background-primary p-4 font-mono text-sm leading-6 text-text-primary outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-primary" />
          </div>
        ) : kind === "html" || kind === "svg" ? (
          <iframe key={revision} title={`Vista previa de ${artifact.title}`} sandbox={kind === "html" ? "allow-scripts" : ""} referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
            srcDoc={artifactPreviewDocument(preview)} className="h-full w-full border-0 bg-white" />
        ) : (
          <div className="h-full overflow-auto p-6 sm:p-8">{kind === "markdown" ? <Markdown>{preview}</Markdown> : <pre className="whitespace-pre-wrap break-words font-sans text-sm">{preview}</pre>}</div>
        )}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border-secondary px-3 py-2 text-[11px] text-text-secondary">
        <span role="status">{notice || (saveStatus === "error" ? "No se pudo guardar localmente. Descarga una copia." : streaming ? "Creando… Podrás editar al terminar." : saveStatus === "saving" ? "Guardando…" : "Guardado en este navegador")}{!notice && !streaming && !artifact.complete ? " · Respuesta incompleta" : ""}</span>
        {artifact.editedContent !== undefined && <Button size="xs" variant="ghost" onClick={() => edit(artifact.key, undefined)}>Restaurar original</Button>}
      </footer>
    </div>
  );
}

export function ArtifactPanel({ artifacts, streamingKey }: { artifacts: Artifact[]; streamingKey?: string }) {
  const { activeKey, isOpen, close } = useArtifacts();
  const [expanded, setExpanded] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [view, setView] = useState<{ key: string; mode: "preview" | "code" } | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    if (isOpen && !narrow && !expanded) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, narrow, expanded, close]);
  const artifact = artifacts.find(a => a.key === activeKey);
  if (!isOpen || !artifact) return null;
  const mode = view?.key === artifact.key ? view.mode : previewKind(artifact) === "code" ? "code" : "preview";
  const content = <PanelContent key={artifact.key} artifact={artifact} artifacts={artifacts} expanded={expanded} onExpand={() => setExpanded(v => !v)} streaming={streamingKey === artifact.key} mode={mode} setMode={mode => setView({ key: artifact.key, mode })} />;
  if (narrow || expanded) return (
    <Dialog.Root open onOpenChange={value => { if (!value) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content aria-describedby={undefined}
          onOpenAutoFocus={() => { lastFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={event => { event.preventDefault(); lastFocused.current?.focus(); }}
          className="fixed inset-y-2 right-2 z-50 w-[calc(100%-1rem)] overflow-hidden rounded-xl border border-border-secondary shadow-xl outline-none">
          <Dialog.Title className="sr-only">{artifact.title}</Dialog.Title>
          {content}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
  return <aside aria-label="Artifacts" className="my-2 mr-2 h-[calc(100%-1rem)] min-w-0 w-[52%] shrink-0 overflow-hidden rounded-xl border border-border-secondary shadow-sm">{content}</aside>;
}
