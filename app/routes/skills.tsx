import { useI18n } from "~/i18n";
import { Zap } from "lucide-react";
import { useLoaderData, useRevalidator } from "react-router";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { listAgentSkills } from "~/.server/acp";

export async function loader() { return listAgentSkills(); }

export default function Skills() {
  const { t } = useI18n();
  const { skills, supported, error } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl overflow-y-auto px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-light text-text-primary">{t("Skills")}</h1>
          <button onClick={() => revalidator.revalidate()} disabled={revalidator.state !== "idle"} className="rounded-lg border border-border-primary px-3 py-1.5 text-sm text-text-secondary disabled:opacity-50">{revalidator.state === "idle" ? t("Refresh") : t("Refreshing…")}</button>
        </div>
        <p className="mt-1 text-sm text-text-secondary">{t("Instructions the agent can use in your conversations.")}</p>
        {error && <p role="alert" className="mt-6 text-sm text-text-danger">{t(error)}</p>}
        {!error && skills.length === 0 && <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-primary px-6 py-16 text-center">
          <Zap className="h-8 w-8 text-text-tertiary" />
          <p className="text-sm text-text-secondary">{supported ? t("No skills are available yet.") : t("This agent does not support listing its skills.")}</p>
        </div>}
        {(["skill", "builtinSkill"] as const).map(type => {
          const group = skills.filter(skill => skill.type === type);
          return group.length > 0 && <section key={type} className="mt-8">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">{type === "skill" ? t("Project skills") : t("Included with the agent")}</h2>
            <ul className="flex flex-col gap-3">{group.map(skill => <li key={skill.id} className="rounded-xl border border-border-primary p-4">
              <h3 className="text-sm font-medium text-text-primary">{skill.name}</h3>
              {skill.description && <p className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">{skill.description}</p>}
              <details className="mt-3 text-xs text-text-secondary"><summary className="cursor-pointer">{t("View instructions")}</summary>
                {skill.path && <p className="mt-2 break-all font-mono text-text-tertiary">{skill.path}</p>}
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-background-secondary p-3">{skill.content || t("No content available.")}</pre>
              </details>
            </li>)}</ul>
          </section>;
        })}
      </div>
    </MainPanelLayout>
  );
}
