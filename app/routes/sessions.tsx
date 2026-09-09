import { Link } from "react-router";
import { History } from "lucide-react";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { useConversations } from "~/components/ConversationContext";


const fecha = (ms: number) =>
  new Date(ms).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });

export default function Sessions() {
  const { conversations, error, loaded, persistent } = useConversations();

  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-light text-text-primary">Historial</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {persistent ? "Tus conversaciones guardadas por el agente. Abre una para continuar." : "Tus conversaciones disponibles."}
        </p>

        {error && <p role="alert" className="mt-4 text-sm text-text-danger">{error}</p>}
        {!loaded && !error && <p role="status" className="mt-4 text-sm text-text-secondary">Cargando historial…</p>}
        {loaded && !persistent && <p className="mt-4 text-sm text-text-secondary">Este agente solo permite mostrar las conversaciones abiertas en este servidor.</p>}
        {conversations.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-primary px-6 py-16 text-center">
            <History className="h-8 w-8 text-text-tertiary" />
            <p className="text-sm text-text-secondary">{loaded ? "Todavía no hay ninguna." : "Esperando al agente…"}</p>
          </div>
        ) : (
          <ul className="mt-8 flex flex-col gap-2">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/c/${encodeURIComponent(c.id)}`}
                  aria-disabled={!c.canOpen}
                  onClick={event => { if (!c.canOpen) event.preventDefault(); }}
                  tabIndex={c.canOpen ? undefined : -1}
                  className="flex flex-col gap-1 rounded-xl border border-border-primary px-4 py-3 transition-colors hover:bg-background-secondary"
                >
                  <span className="text-sm text-text-primary">{c.title}{!c.canOpen && " · No disponible para reabrir"}</span>
                  <span className="flex flex-wrap gap-3 text-xs text-text-tertiary">
                    <span>{fecha(c.updatedAt)}</span>
                    <span>{c.messageCount} mensajes</span>
                    <span>{c.tokens.toLocaleString("es-MX")} tokens</span>
                    {c.busy && <span className="text-text-success">respondiendo</span>}
                  </span>
                </Link>
                {c.canOpen && c.messageCount > 40 && <Link to={`/c/${encodeURIComponent(c.id)}?tail=40`} className="mt-1 inline-block px-4 text-xs text-text-secondary underline">Abrir solo los últimos turnos</Link>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </MainPanelLayout>
  );
}
