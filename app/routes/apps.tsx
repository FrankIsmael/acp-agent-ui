import { useI18n } from "~/i18n";
import { AppWindow } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Apps() {
  const { t } = useI18n();
  return (
    <PlaceholderView
      title={t("Apps")}
      description={t("Interfaces that MCP extensions display in the chat.")}
      icon={AppWindow}
      pending={t("The agent provides /mcp-app-guest, /mcp-app-proxy, and goose.appsList_unstable. Web support using @mcp-ui/client to display apps in chat is pending.")}
    />
  );
}
