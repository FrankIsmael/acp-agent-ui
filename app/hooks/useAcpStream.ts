/**
 * Consume el SSE de una conversación y arma el hilo de mensajes. Todo el ACP
 * ocurre del lado del servidor; aquí sólo llegan eventos ya traducidos.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Por dónde va la conexión con el agente antes del primer `started`. */
export type ConnectPhase = 'waking' | 'connecting' | 'session';

export interface ToolEntry {
  id: string;
  title?: string;
  kind?: string;
  status?: string;
  path?: string;
}

/** Una imagen adjunta, en base64 sin el prefijo `data:` (así la quiere ACP). */
export interface PromptImage {
  mimeType: string;
  data: string;
  name?: string;
}

/**
 * Un selector de la sesión tal como lo declara el agente. El del modelo es el
 * que trae `category: "model"`; ACP no tiene un método aparte para modelos.
 */
export interface ConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type?: 'select' | 'boolean';
  currentValue?: string | boolean;
  options?:
    | { value: string; name: string; description?: string | null }[]
    | {
        group: string;
        name: string;
        options: { value: string; name: string; description?: string | null }[];
      }[];
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  images?: PromptImage[];
  thought?: string;
  tools?: ToolEntry[];
  usage?: { used: number; size: number; cost: number };
}

export interface Usage {
  used: number;
  size: number;
  cost: number;
}

export function useAcpStream(conversationId: string, initial: Turn[] = []) {
  const [turns, setTurns] = useState<Turn[]>(initial);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ConnectPhase>('waking');
  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([]);
  const [imageSupport, setImageSupport] = useState(false);
  const [visionModels, setVisionModels] = useState<string[]>([]);
  // El select se bloquea mientras el agente confirma el cambio: si falla, la
  // lista que llega por SSE lo devuelve solo a su valor real.
  const [configBusy, setConfigBusy] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const streaming = useRef(false);

  useEffect(() => {
    const es = new EventSource(`/api/conversations/${conversationId}/events`);

    // Todo lo que llega durante un turno (texto, pensamiento, herramientas)
    // cae en el mismo mensaje del asistente; si aún no existe, se crea.
    const patchCurrent = (patch: (turn: Turn) => Turn) => {
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (streaming.current && last?.role === 'assistant') {
          next[next.length - 1] = patch(last);
          return next;
        }
        streaming.current = true;
        return [...next, patch({ role: 'assistant', text: '' })];
      });
    };
    const appendChunk = (text: string) =>
      patchCurrent((t) => ({ ...t, text: t.text + text }));
    const appendThought = (text: string) =>
      patchCurrent((t) => ({ ...t, thought: (t.thought ?? '') + text }));
    // Upsert por id: tool_call crea la fila, tool_call_update la completa.
    const upsertTool = (entry: ToolEntry) =>
      patchCurrent((t) => {
        const tools = [...(t.tools ?? [])];
        const i = tools.findIndex((x) => x.id === entry.id);
        if (i === -1) tools.push(entry);
        else tools[i] = { ...tools[i], ...entry };
        return { ...t, tools };
      });

    es.addEventListener('busy', (e) => setBusy(JSON.parse((e as MessageEvent).data).busy));
    es.addEventListener('started', () => setConnected(true));
    es.addEventListener('config', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setConfigOptions(d.options ?? []);
      setImageSupport(!!d.imageSupport);
      setVisionModels(d.visionModels ?? []);
      setConfigBusy(null);
    });
    es.addEventListener('status', (e) =>
      setPhase(
        JSON.parse((e as MessageEvent).data)
          .phase,
      ),
    );
    es.addEventListener('chunk', (e) =>
      appendChunk(JSON.parse((e as MessageEvent).data).text),
    );
    es.addEventListener('thought', (e) =>
      appendThought(JSON.parse((e as MessageEvent).data).text),
    );
    es.addEventListener('tool', (e) =>
      upsertTool(JSON.parse((e as MessageEvent).data)),
    );
    es.addEventListener('usage', (e) => {
      const u = JSON.parse((e as MessageEvent).data) as Usage;
      setUsage(u);
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant')
          next[next.length - 1] = { ...last, usage: u };
        return next;
      });
    });
    es.addEventListener('done', () => {
      streaming.current = false;
      setBusy(false);
    });
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data;
      if (data) {
        setError(JSON.parse(data).message);
        setBusy(false);
        streaming.current = false;
      }
    });
    es.addEventListener('closed', () => {
      setConnected(false);
      setBusy(false);
      streaming.current = false;
      es.close();
    });

    return () => es.close();
  }, [conversationId]);

  const send = useCallback(
    async (text: string, images: PromptImage[] = []) => {
      setTurns((prev) => [...prev, { role: 'user', text, images }]);
      setBusy(true);
      streaming.current = false;
      setError(null);
      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, images }),
        });
        // Un turno rechazado (imagen enorme, conversación muerta) dejaba el input
        // en "pensando" para siempre: sin `done` por SSE, nadie apagaba el busy.
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(body?.error ?? 'No pude mandar el mensaje');
          setBusy(false);
        }
      } catch {
        setError('No pude mandar el mensaje. Inténtalo de nuevo.');
        setBusy(false);
      }
    },
    [conversationId],
  );

  const stop = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/cancel`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'No pude detener la respuesta. Inténtalo de nuevo.');
      }
      // Keep consuming final updates until ACP confirms the cancelled turn.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pude detener la respuesta. Inténtalo de nuevo.');
    }
  }, [conversationId]);

  const setConfig = useCallback(
    async (configId: string, value: string | boolean) => {
      setConfigBusy(configId);
      // Optimista: el select se mueve ya y el SSE confirma. Si el agente
      // rechaza, su lista llega igual y lo devuelve a donde estaba.
      setConfigOptions((prev) =>
        prev.map((o) =>
          o.id === configId ? { ...o, currentValue: value } : o,
        ),
      );
      const res = await fetch(`/api/conversations/${conversationId}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ configId, value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? 'No pude cambiar la configuración');
        setConfigBusy(null);
      }
    },
    [conversationId],
  );

  return {
    turns,
    busy,
    connected,
    phase,
    error,
    usage,
    send,
    stop,
    configOptions,
    imageSupport,
    visionModels,
    configBusy,
    setConfig,
  };
}
