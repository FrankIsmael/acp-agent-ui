import { useI18n } from "~/i18n";
import { useEffect, useState } from "react";
import { useRouteLoaderData } from "react-router";
interface Status { enabled: boolean; exhausted: boolean; turns: number; turnLimit: number; tokens: number; tokenLimit: number; contactUrl: string | null }
export function DemoNotice() {
  const { t } = useI18n();
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
      <p className="font-medium">{t("You have reached this demo's limit.")}</p>
      <p>{t("Want to learn more or build something like this? Let's talk.")}</p>
      <div className="mt-2 flex gap-4">
        <a className="underline" href={status.contactUrl ?? "mailto:ismaelfcom93@gmail.com"}>{t("Contact Ismael")}</a>
        <a className="underline" href="https://www.linkedin.com/in/ismaelfcom/" target="_blank" rel="noreferrer">LinkedIn</a>
      </div>
    </> : <p>{t("demo.summary", { remaining: status ? t("demo.remaining", { count: Math.max(0, status.turnLimit - status.turns) }) : t("Limited use") })}</p>}
  </aside>;
}
