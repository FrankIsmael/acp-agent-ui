import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { getHistorySnapshot } from "~/.server/acp";

type HistoryState = ReturnType<typeof getHistorySnapshot>;
const Context = createContext<HistoryState>({ conversations: [], error: null, loaded: false, persistent: false });

/** La última lista permanece visible durante navegación, desconexiones y refrescos. */
export function ConversationProvider({ initial, children }: { initial: HistoryState; children: ReactNode }) {
  const [state, setState] = useState(initial);
  const { pathname } = useLocation();
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const response = await fetch("/api/conversations", { signal: controller.signal });
        if (!response.ok) throw new Error("history unavailable");
        const next: HistoryState = await response.json();
        if (!controller.signal.aborted) setState(previous => next.error && next.conversations.length === 0 ? { ...previous, error: next.error } : next);
      } catch {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, error: "No pude actualizar el historial. Inténtalo de nuevo." }));
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 15_000);
    window.addEventListener("conversations-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort(); clearInterval(timer);
      window.removeEventListener("conversations-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [pathname]);
  return <Context.Provider value={state}>{children}</Context.Provider>;
}
export const useConversations = () => useContext(Context);
