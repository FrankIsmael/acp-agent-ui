import { AppWindow } from "lucide-react";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { ArtifactCard } from "~/components/artifacts/ArtifactCard";
import { ArtifactPanel } from "~/components/artifacts/ArtifactPanel";
import { useArtifacts } from "~/components/artifacts/ArtifactContext";

export default function Artifacts() {
  const { artifacts, ready, saveStatus } = useArtifacts();
  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0 min-w-0">
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10">
          <div className="mx-auto max-w-3xl">
            <AppWindow className="mb-4 h-7 w-7 text-text-secondary" />
            <h1 className="text-2xl font-semibold">Artifacts</h1>
            <p className="mt-2 text-sm text-text-secondary">Tus creaciones, guardadas en este navegador. Abre, edita o descarga un archivo para compartirlo.</p>
            {saveStatus === "error" && <p role="alert" className="mt-4 text-sm text-text-danger">No se pudo acceder al guardado local. Descarga una copia de tus artifacts.</p>}
            {!ready ? <p className="mt-8 text-sm text-text-secondary">Cargando…</p> : artifacts.length === 0 ? (
              <div className="mt-8 rounded-xl border border-dashed border-border-secondary p-8 text-center text-sm text-text-secondary">Pide en el chat que cree una página web, un documento, código o un gráfico. Tu creación aparecerá aquí automáticamente.</div>
            ) : (
              <div className="mt-6">{[...artifacts].sort((a, b) => b.updatedAt - a.updatedAt).map(artifact => <ArtifactCard key={artifact.key} artifact={artifact} artifactKey={artifact.key} />)}</div>
            )}
          </div>
        </div>
        <ArtifactPanel artifacts={artifacts} />
      </div>
    </MainPanelLayout>
  );
}
