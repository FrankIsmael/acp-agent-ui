import { useEffect, useState } from "react";
import { useRouteLoaderData } from "react-router";
interface Status { enabled: boolean; exhausted: boolean; turns: number; turnLimit: number; tokens: number; tokenLimit: number; contactUrl: string | null }
export function DemoNotice() {
  const demo = useRouteLoaderData("root")?.demo;
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    if (!demo) return;
    const controller = new AbortController();
    const refresh = () => fetch("/api/demo", { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(s => { if (s && !controller.signal.aborted) setStatus(s); }).catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 3000);
    window.addEventListener("demo-limit", refresh);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("demo-limit", refresh); };
  }, [demo]);
  if (!demo) return null;
  return <aside role={status?.exhausted ? "alert" : "status"} className="border-b border-border-secondary bg-background-secondary px-4 py-3 text-sm">
    {status?.exhausted ? <>
      <p className="font-medium">Llegaste al límite de esta demo.</p>
      <p>¿Quieres conocer más o construir algo así? Hablemos.</p>
      <div className="mt-2 flex gap-4">
        <a className="underline" href={status.contactUrl ?? "mailto:ismaelfcom93@gmail.com"}>Contactar a Ismael</a>
        <a className="underline" href="https://www.linkedin.com/in/ismaelfcom/" target="_blank" rel="noreferrer">LinkedIn</a>
      </div>
    </> : <p>Demo gratuita · 1 conversación · {status ? `Hasta ${Math.max(0, status.turnLimit - status.turns)} mensajes más` : "Uso limitado"}. El chat y WhatsApp comparten tu límite en este navegador.</p>}
  </aside>;
}
