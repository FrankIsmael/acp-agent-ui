/**
 * Canal de WhatsApp — spec 5. Aquí se vincula el número (QR o código de 8 caracteres), se ve
 * el estado del canal y se eligen los grupos donde el agente contesta. El estado llega por SSE
 * (`/api/whatsapp/events`); las acciones van por `/api/whatsapp` con `intent`.
 */
import { useEffect, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import { MessageCircle, Smartphone, Users } from "lucide-react";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { Switch } from "~/components/ui/switch";
import { whatsappChannel, type WaGroup, type WaStatus } from "~/.server/whatsapp";

export async function loader() {
  const channel = whatsappChannel();
  return { status: channel.status, groups: await channel.groups(true) };
}

const PHASE_LABEL: Record<WaStatus["phase"], string> = {
  disconnected: "Desconectado",
  connecting: "Conectando…",
  qr_pending: "Esperando el escaneo",
  pairing: "Esperando el código",
  connected: "Conectado",
  failed: "Falló",
};

export default function WhatsApp() {
  const inicial = useLoaderData<typeof loader>();
  const [status, setStatus] = useState<WaStatus>(inicial.status);
  const [groups, setGroups] = useState<WaGroup[]>(inicial.groups);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [phone, setPhone] = useState("");
  const [modo, setModo] = useState<"qr" | "phone">("qr");
  const enCurso = useRef(false);

  useEffect(() => {
    const es = new EventSource("/api/whatsapp/events");
    es.addEventListener("status", e => setStatus(JSON.parse((e as MessageEvent).data).status));
    es.addEventListener("groups", e => setGroups(JSON.parse((e as MessageEvent).data).groups));
    return () => es.close();
  }, []);

  // El QR sale solo al abrir la pantalla si no hay número vinculado ni nada en marcha.
  const autoArrancado = useRef(false);
  useEffect(() => {
    if (autoArrancado.current) return;
    autoArrancado.current = true;
    if (status.phase === "disconnected" && !status.error) void mutar({ intent: "connect" });
  }, []);

  async function mutar(body: Record<string, string>) {
    if (enCurso.current) return;
    enCurso.current = true;
    setOcupado(true);
    setError(null);
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(body)) form.set(k, v);
      const r = await fetch("/api/whatsapp", { method: "POST", body: form });
      const json = await r.json();
      if (json.status) setStatus(json.status);
      if (Array.isArray(json.groups)) setGroups(json.groups);
      if (!r.ok || !json.ok) setError(json.error ?? "algo salió mal");
    } catch {
      setError("No pude hablar con el cliente. Inténtalo de nuevo.");
    } finally {
      enCurso.current = false;
      setOcupado(false);
    }
  }

  const conectado = status.phase === "connected";
  const enHandshake = status.phase === "connecting" || status.phase === "qr_pending" || status.phase === "pairing";
  const boton = "cursor-pointer rounded-lg border border-border-primary px-3 py-1 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";
  const campo = "w-full rounded-lg border border-border-primary bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-border-secondary";

  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl overflow-y-auto px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-light text-text-primary">WhatsApp</h1>
          <span className="flex items-center gap-2 text-xs text-text-secondary">
            <span className={`h-2 w-2 rounded-full ${conectado ? "bg-text-success" : status.phase === "failed" ? "bg-text-danger" : enHandshake ? "animate-pulse bg-text-tertiary" : "bg-border-primary"}`} />
            {PHASE_LABEL[status.phase]}
          </span>
        </div>
        <p className="mt-1 text-sm text-text-secondary">
          La app se vincula como un dispositivo más de tu WhatsApp. Lo que escriban en los grupos
          que prendas abajo entra al mismo hilo que el chat web, y la respuesta del agente vuelve
          al grupo.
        </p>

        {error && (
          <p role="alert" className="mt-4 rounded-xl border border-red-500/40 px-4 py-3 text-sm text-red-500">{error}</p>
        )}
        {status.error && (
          <p role="status" className="mt-4 rounded-xl border border-border-primary px-4 py-3 text-sm text-text-secondary">{status.error}</p>
        )}

        <section className="mt-6 rounded-xl border border-border-primary p-4">
          {conectado ? (
            <div className="flex flex-wrap items-center gap-4">
              <Smartphone className="h-8 w-8 text-text-tertiary" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm text-text-primary">{status.user?.name || "Número vinculado"}</span>
                <span className="font-mono text-xs text-text-tertiary">+{status.user?.id}</span>
              </div>
              <button className={boton} disabled={ocupado} onClick={() => void mutar({ intent: "disconnect" })}>Pausar</button>
              <Desvincular ocupado={ocupado} onConfirm={() => void mutar({ intent: "logout" })} />
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                {(["qr", "phone"] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => setModo(m)}
                    className={`cursor-pointer rounded-lg border px-3 py-1 font-mono text-xs transition-colors ${modo === m ? "border-border-secondary bg-background-secondary text-text-primary" : "border-transparent text-text-tertiary hover:text-text-secondary"}`}
                  >
                    {m === "qr" ? "QR" : "número"}
                  </button>
                ))}
              </div>

              {modo === "qr" ? (
                <div className="mt-4 flex flex-col items-center gap-3">
                  {status.phase === "qr_pending" && status.qr ? (
                    <img src={status.qr} alt="Código QR para vincular" className="h-64 w-64 rounded-xl border border-border-secondary bg-white p-2" />
                  ) : (
                    <div className="flex h-64 w-64 items-center justify-center rounded-xl border border-dashed border-border-primary">
                      <MessageCircle className={`h-8 w-8 text-text-tertiary ${enHandshake ? "animate-pulse" : ""}`} />
                    </div>
                  )}
                  <p className="text-center text-xs text-text-tertiary">
                    WhatsApp → Dispositivos vinculados → Vincular un dispositivo. El QR se renueva solo.
                  </p>
                  <button className={boton} disabled={ocupado || status.phase === "qr_pending"} onClick={() => void mutar({ intent: "connect" })}>
                    {enHandshake ? "Pedir otro QR" : status.error ? "Reconectar" : "Mostrar QR"}
                  </button>
                </div>
              ) : (
                <div className="mt-4 flex flex-col gap-3">
                  {status.phase === "pairing" && status.pairingCode ? (
                    <div className="flex flex-col items-center gap-2 py-4">
                      <span className="font-mono text-3xl tracking-[0.3em] text-text-primary">{status.pairingCode}</span>
                      <p className="text-center text-xs text-text-tertiary">
                        WhatsApp → Dispositivos vinculados → Vincular con el número de teléfono, y escribe este código.
                      </p>
                    </div>
                  ) : (
                    <>
                      <input
                        className={`${campo} font-mono`}
                        inputMode="numeric"
                        placeholder="5215512345678 (con lada, sin +)"
                        value={phone}
                        onChange={e => setPhone(e.target.value)}
                      />
                      <p className="text-xs text-text-tertiary">
                        Si el QR no vincula, WhatsApp da un código de 8 caracteres para el número. Pedirlo cancela el QR.
                      </p>
                    </>
                  )}
                  <button
                    className={`${boton} self-start`}
                    disabled={ocupado || phone.replace(/\D/g, "").length < 8}
                    onClick={() => void mutar({ intent: "pair", phone })}
                  >
                    {status.phase === "pairing" ? "Pedir otro código" : "Pedir código"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-wide text-text-tertiary">Grupos</h2>
          <p className="mb-3 mt-1 text-xs text-text-tertiary">
            El agente sólo contesta en los que estén prendidos. Un grupo nuevo aparece aquí en cuanto
            alguien escribe en él; la lista completa se refresca al recargar.
          </p>
          {groups.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-primary px-6 py-12 text-center">
              <Users className="h-8 w-8 text-text-tertiary" />
              <p className="text-sm text-text-secondary">
                {conectado ? "Todavía no veo grupos. Escribe algo en uno y aparecerá." : "Vincula el número para ver tus grupos."}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {groups.map(g => (
                <li key={g.jid} className="flex items-center gap-3 rounded-xl border border-border-primary px-4 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-sm text-text-primary">{g.subject || "Grupo sin nombre"}</span>
                    <span className="truncate font-mono text-[11px] text-text-tertiary">{g.jid}</span>
                  </div>
                  <Switch checked={g.enabled} disabled={ocupado} onCheckedChange={v => void mutar({ intent: "group", jid: g.jid, enabled: String(v) })} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </MainPanelLayout>
  );
}

function Desvincular({ ocupado, onConfirm }: { ocupado: boolean; onConfirm: () => void }) {
  const [confirmando, setConfirmando] = useState(false);
  if (!confirmando) {
    return (
      <button className="cursor-pointer text-xs text-text-tertiary hover:text-red-500 disabled:opacity-40" disabled={ocupado} onClick={() => setConfirmando(true)}>
        Desvincular
      </button>
    );
  }
  return (
    <>
      <button className="cursor-pointer text-xs text-red-500 disabled:opacity-40" disabled={ocupado} onClick={() => { setConfirmando(false); onConfirm(); }}>
        Sí, desvincular
      </button>
      <button className="cursor-pointer text-xs text-text-tertiary hover:text-text-secondary disabled:opacity-40" disabled={ocupado} onClick={() => setConfirmando(false)}>
        Cancelar
      </button>
    </>
  );
}
