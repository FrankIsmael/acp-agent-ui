/**
 * La conversación. El loader entrega los mensajes ya ocurridos (por si
 * recargas), y de ahí en adelante el hilo lo alimenta el SSE.
 */
import { useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import {
  Brain,
  Check,
  FilePen,
  FileText,
  FolderInput,
  Globe,
  Loader2,
  PanelRightOpen,
  Search,
  Terminal,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useLocation, useLoaderData } from "react-router";
import type { Route } from "./+types/chat";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { ChatInputCard } from "~/components/ChatInputCard";
import { ChatInput } from "~/components/ChatInput";
import { Markdown } from "~/components/Markdown";
import { MessageUsageStats } from "~/components/MessageUsageStats";
import { ConnectingState } from "~/components/ConnectingState";
import { useAcpStream, type ToolEntry, type Turn } from "~/hooks/useAcpStream";
import { config, getConversation, getMessages } from "~/.server/acp";
import { ArtifactCard } from "~/components/artifacts/ArtifactCard";
import { ArtifactPanel } from "~/components/artifacts/ArtifactPanel";
import { useArtifacts } from "~/components/artifacts/ArtifactContext";
import { artifactKey, parseArtifacts, type Artifact, type ArtifactPart } from "~/lib/artifacts";

export async function loader({ params }: Route.LoaderArgs) {
  const conversation = getConversation(params.id);
  if (!conversation) {
    throw new Response("Esa conversación ya no existe", { status: 404 });
  }
  return {
    id: params.id,
    cwd: config.cwd,
    title: conversation.title,
    messages: getMessages(params.id).map((m) => ({
      role: m.role,
      text: m.text,
      images: m.images,
    })),
  };
}

function Bubble({ turn, parts, conversationId, turnIndex, streaming }: { turn: Turn; parts: ArtifactPart[]; conversationId: string; turnIndex: number; streaming: boolean }) {
  if (turn.role === "user") {
    return (
      <div className="flex flex-col items-end gap-2">
        {turn.images && turn.images.length > 0 && (
          <ul className="flex max-w-[80%] flex-wrap justify-end gap-2">
            {turn.images.map((img, i) => (
              <li key={i}>
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={img.name ?? "Imagen adjunta"}
                  title={img.name}
                  className="h-24 w-24 rounded-xl border border-border-secondary object-cover"
                />
              </li>
            ))}
          </ul>
        )}
        {turn.text && (
          <div className="max-w-[80%] rounded-2xl rounded-br-md bg-background-inverse px-4 py-2.5 text-sm text-text-inverse">
            {turn.text}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="max-w-[90%]">
      {turn.thought && (
        <details className="mb-3 text-xs text-text-secondary">
          <summary className="cursor-pointer select-none">Pensando…</summary>
          <p className="mt-2 whitespace-pre-wrap border-l-2 border-border-secondary pl-3">
            {turn.thought}
          </p>
        </details>
      )}
      {turn.tools && turn.tools.length > 0 && (
        <ul className="mb-3 divide-y divide-border-secondary overflow-hidden rounded-xl border border-border-secondary">
          {turn.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </ul>
      )}
      {parts.map((part, index) => part.kind === "text" ? (
        <Markdown key={index}>{part.text}</Markdown>
      ) : (
        <ArtifactCard key={index} artifact={part.artifact} artifactKey={artifactKey(conversationId, turnIndex, part.index)} streaming={streaming && !part.artifact.complete} />
      ))}
      {turn.usage && <MessageUsageStats {...turn.usage} />}
    </div>
  );
}

// Una herramienta del agente, con su estado según ACP:
// pending → in_progress → completed | failed.
// Cada `kind` de ACP tiene su icono: se reconoce de un vistazo qué hizo el
// agente sin leer el título, que es lo que uno hace al barrer la lista.
const KIND_ICON: Record<string, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: FolderInput,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  other: Wrench,
};

const KIND_LABEL: Record<string, string> = {
  read: "Leer",
  edit: "Editar",
  delete: "Borrar",
  move: "Mover",
  search: "Buscar",
  execute: "Ejecutar",
  think: "Pensar",
  fetch: "Traer",
  other: "Herramienta",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "En cola",
  in_progress: "Ejecutando",
  completed: "Listo",
  failed: "Falló",
};

/** El indicador de la derecha: spinner mientras corre, palomita al terminar. */
function StatusDot({ status }: { status: string }) {
  if (status === "in_progress") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-text-primary" />;
  }
  if (status === "completed") {
    return <Check className="h-3.5 w-3.5 text-text-success" strokeWidth={3} />;
  }
  if (status === "failed") {
    return <X className="h-3.5 w-3.5 text-text-danger" strokeWidth={3} />;
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-border-primary" />;
}

function ToolRow({ tool }: { tool: ToolEntry }) {
  const status = tool.status ?? "pending";
  const running = status === "in_progress";
  const failed = status === "failed";
  const kind = tool.kind ?? "other";
  const Icon = KIND_ICON[kind] ?? Wrench;
  // Del path importa el final (el archivo), no el prefijo: se trunca por la
  // izquierda para que `…/routes/chat.tsx` siga siendo legible en móvil.
  const path = tool.path;

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={`group flex min-w-0 items-center gap-2.5 px-3 py-2 transition-colors ${
        failed ? "bg-background-danger/40" : running ? "bg-background-secondary/60" : ""
      }`}
      title={path ? `${KIND_LABEL[kind] ?? kind}: ${tool.title ?? tool.id}\n${path}` : undefined}
    >
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${
          failed
            ? "border-border-danger text-text-danger"
            : running
              ? "border-border-primary text-text-primary"
              : "border-border-secondary text-text-tertiary"
        }`}
        aria-hidden
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span
          className={`truncate text-xs ${failed ? "text-text-danger" : "text-text-primary"}`}
        >
          {tool.title ?? tool.id}
        </span>
        {path && (
          <span dir="rtl" className="truncate text-left font-mono text-[11px] text-text-tertiary">
            &#x2066;{path}&#x2069;
          </span>
        )}
      </div>

      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <StatusDot status={status} />
      </span>
      <span className="sr-only">{STATUS_LABEL[status] ?? status}</span>
    </motion.li>
  );
}

// Cada conversación necesita su propio estado: sin la key, React reusa la
// instancia al navegar entre /c/:id y el hilo anterior se queda pegado.
export default function Chat() {
  const { id } = useLoaderData<typeof loader>();
  return <ChatView key={id} />;
}

function ChatView() {
  const { id, cwd, messages } = useLoaderData<typeof loader>();
  const location = useLocation();
  const firstMessage = (location.state as { firstMessage?: string } | null)?.firstMessage;
  const {
    turns, busy, connected, phase, error, send,
    configOptions, imageSupport, visionModels, configBusy, setConfig,
  } = useAcpStream(id, messages as Turn[]);
  const { artifacts, ready, ingest, open } = useArtifacts();
  const parsedTurns = useMemo(() => turns.map((turn, index) => turn.role === "assistant" ? parseArtifacts(turn.text, busy && index === turns.length - 1) : []), [turns, busy]);
  const generated = useMemo(() => parsedTurns.flatMap((parts, turnIndex) => parts.flatMap((part): Artifact[] => part.kind === "artifact" ? [{
    ...part.artifact, key: artifactKey(id, turnIndex, part.index), conversationId: id, turnIndex, updatedAt: Date.now(),
  }] : [])), [parsedTurns, id]);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!ready) return;
    ingest(generated);
    const additions = generated.filter(artifact => !seen.current.has(artifact.key));
    generated.forEach(artifact => seen.current.add(artifact.key));
    // Once closed, further tokens must not reopen the panel. A new revision can.
    if (additions.length) open(additions[additions.length - 1].key);
  }, [generated, ready, ingest, open]);
  const conversationArtifacts = artifacts.filter(artifact => artifact.conversationId === id);
  const streamingArtifact = busy ? [...generated].reverse().find(artifact => artifact.turnIndex === turns.length - 1 && !artifact.complete) : undefined;
  const sentFirst = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  // El primer mensaje viene del Hub; se manda una sola vez y en cuanto el
  // agente terminó de conectarse.
  useEffect(() => {
    if (!firstMessage || sentFirst.current || !connected) return;
    sentFirst.current = true;
    void send(firstMessage);
  }, [firstMessage, connected, send]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0 min-w-0">
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          {conversationArtifacts.length > 0 && (
            <div className="flex justify-end px-4 pt-2">
              <button onClick={() => open(conversationArtifacts[conversationArtifacts.length - 1].key)} className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:bg-background-secondary"><PanelRightOpen className="h-4 w-4" />Artifacts · {conversationArtifacts.length}</button>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
              {!connected && turns.length === 0 && (
                <ConnectingState phase={phase} error={error} />
              )}
              {turns.map((turn, i) => (
                <Bubble key={i} turn={turn} parts={parsedTurns[i]} conversationId={id} turnIndex={i} streaming={busy && i === turns.length - 1} />
              ))}

              {busy && turns[turns.length - 1]?.role === "user" && (
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-tertiary"
                      style={{ animationDelay: `${i * 150}ms` }}
                    />
                  ))}
                </div>
              )}
              {error && (connected || turns.length > 0) && (
                <p className="text-sm text-text-danger">{error}</p>
              )}
              <div ref={bottom} />
            </div>
          </div>

          <div className="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6 sm:pb-6">
            <ChatInputCard>
              <ChatInput
                onSubmit={send}
                busy={busy}
                workingDir={cwd}
                imageSupport={imageSupport}
                visionModels={visionModels}
                configOptions={configOptions}
                configBusy={configBusy}
                onConfigChange={setConfig}
                disabled={!connected}
                placeholder={connected ? "Sigue la conversación…" : "Conectando con el agente…"}
              />
            </ChatInputCard>
          </div>
        </div>
        <ArtifactPanel artifacts={conversationArtifacts} streamingKey={streamingArtifact?.key} />
      </div>
    </MainPanelLayout>
  );
}
