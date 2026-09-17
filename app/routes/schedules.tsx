import { useI18n } from "~/i18n";
import { Clock } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Schedules() {
  const { t } = useI18n();
  return (
    <PlaceholderView
      title={t("Schedules")}
      description={t("Conversations that start automatically on a schedule.")}
      icon={Clock}
      pending={t("Schedules use ACP methods such as goose.schedulesList_unstable. They require the agent to run with --enable-scheduler, which the systemd unit does not currently pass.")}
    />
  );
}
