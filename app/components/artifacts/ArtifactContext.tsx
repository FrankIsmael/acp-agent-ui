import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ARTIFACT_STORAGE_KEY, mergeArtifacts, readArtifactStorage, type Artifact } from "~/lib/artifacts";

type SaveStatus = "loading" | "saving" | "saved" | "error";
interface ArtifactStore {
  artifacts: Artifact[];
  ready: boolean;
  activeKey: string | null;
  isOpen: boolean;
  saveStatus: SaveStatus;
  ingest: (artifacts: Artifact[]) => void;
  open: (key: string) => void;
  close: () => void;
  edit: (key: string, content: string | undefined) => void;
}
const Context = createContext<ArtifactStore | null>(null);

export function ArtifactProvider({ children }: { children: ReactNode }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [ready, setReady] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const latest = useRef(artifacts);
  const saved = useRef(artifacts);

  useEffect(() => {
    try {
      const restored = readArtifactStorage(localStorage.getItem(ARTIFACT_STORAGE_KEY));
      saved.current = restored;
      latest.current = restored;
      setArtifacts(restored);
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
    setReady(true);
  }, []);

  const persist = useCallback(() => {
    if (saved.current === latest.current) return;
    try {
      localStorage.setItem(ARTIFACT_STORAGE_KEY, JSON.stringify({ version: 1, artifacts: latest.current }));
      saved.current = latest.current;
      setSaveStatus("saved");
    } catch {
      // Private browsing, denied storage and quota errors must not lose the editor.
      setSaveStatus("error");
    }
  }, []);

  useEffect(() => {
    // During hydration (and StrictMode's mount/cleanup replay), the rendered
    // array is still empty. Keep the restored snapshot until state catches up.
    if (!ready) return;
    latest.current = artifacts;
    if (saved.current === artifacts) return;
    setSaveStatus("saving");
    const timer = window.setTimeout(persist, 400);
    return () => window.clearTimeout(timer);
  }, [artifacts, ready, persist]);

  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === "hidden") persist(); };
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", onHidden);
      persist();
    };
  }, [persist]);

  const ingest = useCallback((incoming: Artifact[]) => setArtifacts(current => mergeArtifacts(current, incoming)), []);
  const open = useCallback((key: string) => { setActiveKey(key); setIsOpen(true); }, []);
  const close = useCallback(() => setIsOpen(false), []);
  const edit = useCallback((key: string, editedContent: string | undefined) => {
    setArtifacts(current => current.map(a => a.key === key ? { ...a, editedContent, updatedAt: Date.now() } : a));
  }, []);

  return <Context.Provider value={{ artifacts, ready, activeKey, isOpen, saveStatus, ingest, open, close, edit }}>{children}</Context.Provider>;
}

export function useArtifacts() {
  const value = useContext(Context);
  if (!value) throw new Error("useArtifacts requires ArtifactProvider");
  return value;
}
