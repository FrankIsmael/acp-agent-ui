import { useI18n } from "~/i18n";
import { AppWindow } from "lucide-react";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { ArtifactCard } from "~/components/artifacts/ArtifactCard";
import { ArtifactPanel } from "~/components/artifacts/ArtifactPanel";
import { useArtifacts } from "~/components/artifacts/ArtifactContext";

export default function Artifacts() {
  const { t } = useI18n();
  const { artifacts, ready, saveStatus } = useArtifacts();
  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0 min-w-0">
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10">
          <div className="mx-auto max-w-3xl">
            <AppWindow className="mb-4 h-7 w-7 text-text-secondary" />
            <h1 className="text-2xl font-semibold">{t("Artifacts")}</h1>
            <p className="mt-2 text-sm text-text-secondary">{t("Your creations, saved in this browser. Open, edit, or download a file to share it.")}</p>
            {saveStatus === "error" && <p role="alert" className="mt-4 text-sm text-text-danger">{t("Could not access local storage. Download a copy of your artifacts.")}</p>}
            {!ready ? <p className="mt-8 text-sm text-text-secondary">{t("Loading…")}</p> : artifacts.length === 0 ? (
              <div className="mt-8 rounded-xl border border-dashed border-border-secondary p-8 text-center text-sm text-text-secondary">{t("Ask the agent to create a web page, document, code, or chart. Your creation will appear here automatically.")}</div>
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
