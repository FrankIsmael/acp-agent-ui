import { useI18n } from "~/i18n";
import { FileText } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Recipes() {
  const { t } = useI18n();
  return (
    <PlaceholderView
      title={t("Recipes")}
      description={t("Saved prompts that start a conversation with parameters.")}
      icon={FileText}
      pending={t("Recipes use ACP methods such as goose.recipesList_unstable (Save, Delete, Parse). Calling them from app/.server/acp.ts over the existing connection is pending.")}
    />
  );
}
