/**
 * Extensiones — los servidores MCP que este Cliente le da al Agente.
 *
 * La pantalla enseña dos listas a propósito: arriba lo que declaramos
 * nosotros (nuestra base sqlite) y abajo lo que el Agente reporta como
 * conectado al hilo abierto. Son dos verdades distintas y conviene verlas
 * separadas. Desde cada lista se puede cruzar a la otra: conectar una
 * declarada al hilo, o retirar del hilo una conectada.
 */
import { useI18n } from "~/i18n";
import { useRef, useState } from "react";
import { Link, useLoaderData, useRevalidator } from "react-router";
import { Puzzle, Trash2 } from "lucide-react";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { Switch } from "~/components/ui/switch";
import { listClientExtensions, listSessionExtensions } from "~/.server/acp";
import { demoEnabled } from "~/.server/demo";
import type { ExtensionSummary } from "~/.server/extensions";

type Transport = "stdio" | "http";

export async function loader() {
  if (demoEnabled()) return { demo: true, declaradas: await listClientExtensions(), reportadas: null };
  const [declaradas, reportadas] = await Promise.all([listClientExtensions(), listSessionExtensions()]);
  return { demo: false, declaradas, reportadas };
}

type Reportadas = Awaited<ReturnType<typeof loader>>["reportadas"];

export default function Extensions() {
  const { t } = useI18n();
  const { demo, declaradas, reportadas: iniciales } = useLoaderData<typeof loader>();
  const [extensiones, setExtensiones] = useState<ExtensionSummary[]>(declaradas.extensions);
  const [reportadas, setReportadas] = useState<Reportadas>(iniciales);
  const [error, setError] = useState<string | null>(declaradas.error);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const enCurso = useRef(false);
  if (demo) return <DemoExtensions extensions={declaradas.extensions} error={declaradas.error} />;

  // Un solo verbo con `intent`, como en /api/extensions. La respuesta siempre
  // trae las dos listas completas: así la pantalla se pinta sin segunda vuelta.
  async function mutar(body?: Record<string, string>) {
    if (enCurso.current) return;
    enCurso.current = true;
    setOcupado(true);
    setError(null);
    setAviso(null);
    try {
      let init: RequestInit | undefined;
      if (body) {
        const form = new FormData();
        for (const [k, v] of Object.entries(body)) form.set(k, v);
        init = { method: "POST", body: form };
      }
      const r = await fetch("/api/extensions", init);
      const json = await r.json();
      if (Array.isArray(json.extensions)) {
        setExtensiones(json.extensions);
        setReportadas(json.session);
      }
      if (!r.ok || !json.ok) return setError(json.error ?? t("something went wrong"));
      if (body?.intent === "add") {
        setAviso(t("Extension added. Connect it to the open conversation using its button, or it will join the next conversation you open."));
      } else if (body?.intent === "session-add") {
        setAviso(t("Connected to the open conversation. Ask the agent which tools it has."));
      } else if (body?.intent === "session-remove") {
        setAviso(t("Removed from the open conversation."));
      }
      return true;
    } catch {
      setError(t("Could not reach the client. Please try again."));
    } finally {
      enCurso.current = false;
      setOcupado(false);
    }
  }

  const conectada = (e: ExtensionSummary) =>
    !!reportadas && !reportadas.error && reportadas.extensions.some((r) => r.name === e.name);

  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl overflow-y-auto px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-light text-text-primary">{t("Extensions")}</h1>
          <button
            onClick={() => void mutar()}
            disabled={ocupado}
            className="cursor-pointer rounded-lg border border-border-primary px-3 py-1 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("Refresh")}
          </button>
        </div>
        <p className="mt-1 text-sm text-text-secondary">
          {t("extensions.description")}
        </p>

        <Formulario ocupado={ocupado} onCrear={(body) => mutar({ intent: "add", ...body })} />

        {error && (
          <p role="alert" className="mt-4 rounded-xl border border-red-500/40 px-4 py-3 text-sm text-red-500">
            {t(error)}
          </p>
        )}
        {aviso && (
          <p role="status" className="mt-4 rounded-xl border border-border-primary px-4 py-3 text-sm text-text-secondary">
            {aviso}
          </p>
        )}

        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-wide text-text-tertiary">
            {t("Configured extensions")}
          </h2>
          <p className="mb-3 mt-1 text-xs text-text-tertiary">
            {t("These are stored in this client and sent to the agent whenever a conversation opens.")}
          </p>
          {extensiones.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-primary px-6 py-12 text-center">
              <Puzzle className="h-8 w-8 text-text-tertiary" />
              <p className="text-sm text-text-secondary">{t("You have not added any extensions yet.")}</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {extensiones.map((e, i) => (
                <Fila
                  key={e.key ?? i}
                  extension={e}
                  ocupado={ocupado}
                  puedeConectar={!!reportadas && !reportadas.error && !reportadas.busy && !conectada(e)}
                  onConectar={() =>
                    void mutar({ intent: "session-add", configKey: e.key!, sessionId: reportadas!.id })
                  }
                  onToggle={(v) => void mutar({ intent: "set-enabled", configKey: e.key!, enabled: String(v) })}
                  onQuitar={() => void mutar({ intent: "remove", configKey: e.key! })}
                />
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-text-tertiary">
            {t("Removing an extension from this list leaves it connected to the current conversation until that conversation ends or you remove it below.")}
          </p>
        </section>

        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-wide text-text-tertiary">
            {t("Currently connected")}
          </h2>
          <p className="mb-3 mt-1 text-xs text-text-tertiary">
            {t("The agent reports these extensions for the open conversation, including built-in tools. The list above shows what was requested; this list shows what is connected.")}
          </p>
          {!reportadas ? (
            <p className="rounded-xl border border-border-primary px-4 py-3 text-sm text-text-secondary">
              {t("Open a conversation, then return here to see its connected extensions.")}
            </p>
          ) : (
            <>
              <p className="mb-3 text-xs text-text-tertiary">
                {t("Open conversation:")}{" "}
                <Link className="underline" to={`/c/${encodeURIComponent(reportadas.id)}`}>
                  {reportadas.title === "Nueva conversación" ? t("New conversation") : reportadas.title}
                </Link>
                {reportadas.busy && (
                  <>  {t("— the agent is working; stop the turn or wait before changing its tools.")}</>
                )}
              </p>
              {reportadas.error ? (
                <p className="rounded-xl border border-border-primary px-4 py-3 text-sm text-text-secondary">
                  {t(reportadas.error)}
                </p>
              ) : reportadas.extensions.length === 0 ? (
                <p className="rounded-xl border border-border-primary px-4 py-3 text-sm text-text-secondary">
                  {t("This conversation has no connected extensions.")}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {reportadas.extensions.map((e, i) => (
                    <li
                      key={e.key ?? i}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border-primary px-4 py-3"
                    >
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="text-sm text-text-primary">{e.name}</span>
                        {e.description && (
                          <span className="truncate text-xs text-text-secondary">{e.description}</span>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-[11px] text-text-tertiary">{e.type}</span>
                      {e.key && (
                        <button
                          onClick={() =>
                            void mutar({ intent: "session-remove", configKey: e.key!, sessionId: reportadas.id })
                          }
                          disabled={ocupado || reportadas.busy}
                          className="cursor-pointer text-text-tertiary transition-colors hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                          title={t("Remove from conversation")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
    </MainPanelLayout>
  );
}

/** The public catalog exposes available tools, never another guest's active session. */
function DemoExtensions({ extensions, error }: { extensions: ExtensionSummary[]; error: string | null }) {
  const { t } = useI18n();
  const revalidator = useRevalidator();
  const available = extensions.filter(extension => extension.enabled);
  return <MainPanelLayout>
    <div className="mx-auto w-full max-w-3xl overflow-y-auto px-6 py-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-light text-text-primary">{t("Extensions")}</h1>
        <button onClick={() => revalidator.revalidate()} disabled={revalidator.state !== "idle"}
          className="rounded-lg border border-border-primary px-3 py-1 text-xs disabled:opacity-40">{t("Refresh")}</button>
      </div>
      <p className="mt-2 text-sm text-text-secondary">{t("Tools available to the agent. Ask the agent to use them in chat.")}</p>
      <p className="mt-2 text-sm text-text-secondary">{t("Ismael manages this demo's extension settings.")}</p>
      {error && <p role="alert" className="mt-4 text-text-danger">{t(error)}</p>}
      {!error && available.length === 0 && <p className="mt-6 text-sm text-text-secondary">{t("No extensions are configured yet.")}</p>}
      <ul className="mt-6 flex flex-col gap-2">{available.map((extension, index) =>
        <li key={extension.key ?? index} className="rounded-xl border border-border-primary p-4">
          <h2 className="text-sm font-medium">{extension.name}</h2>
          {extension.description && <p className="mt-1 text-sm text-text-secondary">{extension.description}</p>}
        </li>
      )}</ul>
    </div>
  </MainPanelLayout>;
}

function Fila({
  extension: e,
  ocupado,
  puedeConectar,
  onConectar,
  onToggle,
  onQuitar,
}: {
  extension: ExtensionSummary;
  ocupado: boolean;
  puedeConectar: boolean;
  onConectar: () => void;
  onToggle: (enabled: boolean) => void;
  onQuitar: () => void;
}) {
  const { t } = useI18n();
  const [confirmando, setConfirmando] = useState(false);
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border-primary px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm text-text-primary">{e.name}</span>
        <span className="truncate font-mono text-[11px] text-text-tertiary">
          {e.type}
          {e.description && <span className="font-sans"> · {e.description}</span>}
        </span>
      </div>
      {e.key && puedeConectar && (
        <button
          onClick={onConectar}
          disabled={ocupado}
          className="cursor-pointer rounded-lg border border-border-primary px-2 py-1 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("Connect to conversation")}
        </button>
      )}
      <Switch checked={e.enabled} disabled={ocupado || !e.key} onCheckedChange={onToggle} />
      {confirmando ? (
        <>
          <button
            onClick={() => { setConfirmando(false); onQuitar(); }}
            disabled={ocupado}
            className="cursor-pointer text-xs text-red-500 disabled:opacity-40"
          >
            {t("Remove")}
          </button>
          <button
            onClick={() => setConfirmando(false)}
            disabled={ocupado}
            className="cursor-pointer text-xs text-text-tertiary hover:text-text-secondary disabled:opacity-40"
          >
            {t("Cancel")}
          </button>
        </>
      ) : (
        <button
          onClick={() => setConfirmando(true)}
          disabled={ocupado || !e.key}
          className="cursor-pointer text-text-tertiary transition-colors hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          title={t("Remove")}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </li>
  );
}

function Formulario({
  ocupado,
  onCrear,
}: {
  ocupado: boolean;
  onCrear: (body: Record<string, string>) => Promise<true | void>;
}) {
  const { t } = useI18n();
  const [transport, setTransport] = useState<Transport>("stdio");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [command, setCommand] = useState("/usr/local/bin/node");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  // Un renglón por variable, `NOMBRE=valor`. Es el formato que ya se conoce de
  // un .env: nadie tiene que aprender otra sintaxis para pegar un token. El
  // servidor lo valida tal cual, así que se manda entero.
  const [pares, setPares] = useState("");

  const campo =
    "w-full rounded-lg border border-border-primary bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-border-secondary";

  return (
    <div className="mt-6 flex flex-col gap-3 rounded-xl border border-border-primary p-4">
      <div className="flex gap-2">
        {(["stdio", "http"] as Transport[]).map((t) => (
          <button
            key={t}
            onClick={() => setTransport(t)}
            className={`cursor-pointer rounded-lg border px-3 py-1 font-mono text-xs transition-colors ${
              transport === t
                ? "border-border-secondary bg-background-secondary text-text-primary"
                : "border-transparent text-text-tertiary hover:text-text-secondary"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <input
        className={campo}
        placeholder={t("name (as the agent will see it)")}
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className={campo}
        placeholder={t("description (optional)")}
        maxLength={500}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      {transport === "stdio" ? (
        <>
          <input
            className={`${campo} font-mono`}
            placeholder="/usr/local/bin/node"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <input
            className={`${campo} font-mono`}
            placeholder="/data/repo/mcp/hello.ts"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
          <p className="text-xs text-text-tertiary">
            {t("Use absolute paths for both fields. The agent starts the process inside its box and does not inherit your PATH.")}
          </p>
        </>
      ) : (
        <input
          className={`${campo} font-mono`}
          placeholder="https://…/api/mcp"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      )}

      <textarea
        className={`${campo} min-h-[72px] font-mono`}
        autoComplete="off"
        spellCheck={false}
        placeholder={
          transport === "stdio"
            ? t("extensions.environment")
            : t("extensions.headers")
        }
        value={pares}
        onChange={(e) => setPares(e.target.value)}
      />
      <p className="text-xs text-text-tertiary">
        {transport === "stdio"
          ? t("These are passed to the process as environment variables.")
          : t("These are sent with every server request and stored as plain text in this client's database.")}
      </p>

      <button
        onClick={async () => {
          const ok = await onCrear(
            transport === "stdio"
              ? { name, description, transport, command, args: args.split(/\s+/).filter(Boolean).join("\n"), env: pares }
              : { name, description, transport, url, headers: pares },
          );
          if (!ok) return;
          setName("");
          setDescription("");
          setArgs("");
          setUrl("");
          setPares("");
        }}
        disabled={!name || ocupado}
        className="cursor-pointer self-start rounded-lg bg-background-inverse px-4 py-2 text-sm text-text-inverse transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {t("Add extension")}
      </button>
    </div>
  );
}
