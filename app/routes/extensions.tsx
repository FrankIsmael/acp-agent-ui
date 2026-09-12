import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Puzzle } from "lucide-react";
import type { Route } from "./+types/extensions";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { listClientExtensions, listSessionExtensions } from "~/.server/acp";
import type { ExtensionSummary } from "~/.server/extensions";

export async function loader() {
  const [config, session] = await Promise.all([listClientExtensions(), listSessionExtensions()]);
  return { ...config, session };
}

const inputClass = "mt-1 w-full rounded-lg border border-border-primary bg-background-primary px-3 py-2 text-sm";
const buttonClass = "rounded-lg border border-border-primary px-3 py-2 text-sm hover:bg-background-secondary disabled:opacity-50";

function ExtensionRow({ extension, session, busy, onSubmit, live = false }: {
  extension: ExtensionSummary; session: Awaited<ReturnType<typeof loader>>["session"]; live?: boolean;
  busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="rounded-xl border border-border-primary p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-sm font-medium">{extension.name}</h2>
          <p className="text-xs text-text-secondary">{extension.type} · {extension.enabled ? "Activada" : "Desactivada"}</p>
        </div>
        {extension.key && <form action="/api/extensions" method="post" onSubmit={onSubmit} className="flex flex-wrap gap-2">
          <input type="hidden" name="configKey" value={extension.key} />
          {session && <input type="hidden" name="sessionId" value={session.id} />}
          <input type="hidden" name="enabled" value={String(!extension.enabled)} />
          {live ? <button className={buttonClass} name="intent" value="session-remove" disabled={busy || session?.busy}>Retirar de la conversación</button> : <>
          {session && !session.error && !session.extensions.some(item => item.name === extension.name) && <button className={buttonClass} name="intent" value="session-add" disabled={busy || session.busy}>Conectar a conversación</button>}
          <button className={buttonClass} name="intent" value="set-enabled" disabled={busy}>{extension.enabled ? "Desactivar" : "Activar"}</button>
          {confirming ? <>
            <button className={buttonClass} name="intent" value="remove" disabled={busy}>Confirmar eliminación</button>
            <button className={buttonClass} type="button" onClick={() => setConfirming(false)} disabled={busy}>Cancelar</button>
          </> : <button className={buttonClass} type="button" onClick={() => setConfirming(true)} disabled={busy}>Eliminar</button>}
          </>}
        </form>}
      </div>
      {extension.description && <p className="mt-2 text-sm text-text-secondary">{extension.description}</p>}
    </li>
  );
}

export default function Extensions({ loaderData }: Route.ComponentProps) {
  const [snapshot, setSnapshot] = useState(loaderData);
  const { extensions, error, session } = snapshot;
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error?: string; message?: string }>({});
  const pending = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [transport, setTransport] = useState("http");

  async function request(body?: FormData) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFeedback({});
    try {
      const response = await fetch("/api/extensions", body ? { method: "POST", body } : undefined);
      const result = await response.json();
      if (Array.isArray(result.extensions)) setSnapshot({ extensions: result.extensions, session: result.session, error: result.loadError });
      if (!response.ok || !result.ok) throw new Error(result.error || "No pude actualizar las extensiones");
      if (body?.get("intent") === "add") {
        formRef.current?.reset();
        setFeedback({ message: "Extensión guardada. Conéctala a la conversación activa o inicia una nueva." });
      } else if (body) setFeedback({ message: "Cambio guardado." });
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : "No pude actualizar las extensiones" });
    } finally { pending.current = false; setBusy(false); }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void request(new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter));
  }
  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl overflow-y-auto px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-light">Extensiones</h1>
          <button className={buttonClass} disabled={busy} onClick={() => void request()}>Actualizar</button>
        </div>
        <p className="mt-2 text-sm text-text-secondary">Conecta herramientas MCP al agente y elige cuáles puede usar en cada conversación.</p>
        {feedback.error && <p role="alert" className="mt-4 text-sm text-text-danger">{feedback.error}</p>}
        {feedback.message && <p role="status" className="mt-4 text-sm text-text-secondary">{feedback.message}</p>}
        {session && <section className="mt-6">
          <h2 className="font-medium">Conversación activa: <Link className="underline" to={`/c/${encodeURIComponent(session.id)}`}>{session.title}</Link></h2>
          {session.busy && <p className="mt-2 text-sm text-text-secondary">El agente está trabajando. Detén el turno o espera a que termine para cambiar sus herramientas.</p>}
          {session.error ? <p role="alert" className="mt-2 text-sm text-text-danger">{session.error}</p> : <>
            {!session.extensions.length && <p className="mt-2 text-sm text-text-secondary">Esta conversación no tiene extensiones conectadas.</p>}
            <ul className="mt-3 flex flex-col gap-3">{session.extensions.map((extension, index) => <ExtensionRow key={extension.key ?? index} extension={extension} session={session} busy={busy} onSubmit={onSubmit} live />)}</ul>
          </>}
        </section>}
        <h2 className="mt-8 font-medium">Extensiones de este cliente</h2>
        <p className="mt-2 text-sm text-text-secondary">Las extensiones activadas se declaran al abrir conversaciones. Puedes conectar una extensión guardada a la conversación activa con su botón. Desactivarla aquí no retira una herramienta ya conectada.</p>
        {error && <p role="alert" className="mt-6 text-sm text-text-danger">{error}</p>}
        {!error && !extensions.length && <div className="mt-6 flex items-center gap-3 rounded-xl border border-dashed border-border-primary p-6 text-sm text-text-secondary">
          <Puzzle className="h-6 w-6 shrink-0" />
          Todavía no hay extensiones configuradas.
        </div>}
        <ul className="mt-6 flex flex-col gap-3">{extensions.map((extension, index) => <ExtensionRow key={extension.key ?? index} extension={extension} session={session} busy={busy} onSubmit={onSubmit} />)}</ul>
        {!error && <form ref={formRef} action="/api/extensions" method="post" onSubmit={onSubmit} className="mt-8 space-y-4 rounded-xl border border-border-primary p-5">
          <h2 className="font-medium">Conectar servidor MCP</h2>
          <fieldset disabled={busy} className="space-y-4 disabled:opacity-50">
            <input type="hidden" name="intent" value="add" />
            <label className="block text-sm">Nombre<input className={inputClass} name="name" required maxLength={80} placeholder="Nombre del servidor" /></label>
            <label className="block text-sm">Descripción<input className={inputClass} name="description" maxLength={500} /></label>
            <label className="block text-sm">Conexión<select className={inputClass} name="transport" value={transport} onChange={event => setTransport(event.target.value)}>
              <option value="http">HTTP</option><option value="stdio">Comando (stdio)</option>
            </select></label>
            {transport === "http" ? <>
              <label className="block text-sm">URL<input className={inputClass} name="url" type="url" required maxLength={2048} placeholder="https://servidor.example/mcp" /></label>
              <label className="block text-sm">Cabeceras (opcional)<textarea className={inputClass} name="headers" maxLength={16000} autoComplete="off" spellCheck={false} placeholder="Authorization=Bearer …" /></label>
            </> : <>
              <p className="text-xs text-text-secondary">El comando se ejecuta en la máquina del agente y debe estar instalado allí.</p>
              <label className="block text-sm">Ejecutable<input className={inputClass} name="command" required maxLength={2048} placeholder="npx" /></label>
              <label className="block text-sm">Argumentos (uno por línea)<textarea className={inputClass} name="args" maxLength={16000} placeholder={"-y\npaquete-mcp"} /></label>
              <label className="block text-sm">Variables de entorno (opcional)<textarea className={inputClass} name="env" maxLength={16000} autoComplete="off" spellCheck={false} placeholder="API_KEY=…" /></label>
            </>}
            <button className={buttonClass} type="submit">{busy ? "Guardando…" : "Conectar extensión"}</button>
          </fieldset>
        </form>}
      </div>
    </MainPanelLayout>
  );
}
