/**
 * Panel de navegación — mismo esqueleto que el del Desktop: items arriba, la
 * lista de chats en medio y Ajustes anclado abajo.
 */
import { useI18n } from "~/i18n";
import { Link, useLocation, useRouteLoaderData } from "react-router";
import { motion } from "motion/react";
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  History,
  MessageCircle,
  MessageSquarePlus,
  Puzzle,
  Settings,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { useConversations } from "~/components/ConversationContext";
import { cn } from "~/lib/utils";
import type { ConversationSummary } from "~/.server/acp";

interface NavItem {
  id: string;
  path: string;
  label: string;
  icon: LucideIcon;
}

function NavRow({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.path}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-background-tertiary text-text-primary"
          : "text-text-secondary hover:bg-background-secondary hover:text-text-primary"
      )}
    >
      <Icon className="h-5 w-5 flex-shrink-0 text-text-secondary" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function SessionRow({
  conversation,
  active,
}: {
  conversation: ConversationSummary;
  active: boolean;
}) {
  const { t } = useI18n();
  return (
    <Link
      to={`/c/${encodeURIComponent(conversation.id)}`}
      aria-disabled={!conversation.canOpen}
      tabIndex={conversation.canOpen ? undefined : -1}
      onClick={event => { if (!conversation.canOpen) event.preventDefault(); }}
      className={cn(
        "flex flex-col gap-0.5 rounded-lg px-3 py-2 transition-colors",
        active
          ? "bg-background-tertiary"
          : "hover:bg-background-secondary"
      )}
    >
      <span className="truncate text-sm text-text-primary">
        {conversation.title === "Nueva conversación" ? t("New conversation") : conversation.title}
      </span>
      <span className="flex items-center gap-2 text-[11px] text-text-tertiary">
        {conversation.busy && (
          <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-text-success" />
        )}
        {t("messages.count", { count: conversation.messageCount })}
      </span>
    </Link>
  );
}

export function NavigationPanel({
  conversations,
}: {
  conversations: ConversationSummary[];
}) {
  const { t } = useI18n();
  const NAV_ITEMS: NavItem[] = [
    { id: "home", path: "/c/nuevo", label: t("New conversation"), icon: MessageSquarePlus },
    { id: "artifacts", path: "/artifacts", label: t("Artifacts"), icon: AppWindow },
    { id: "recipes", path: "/recipes", label: t("Recipes"), icon: FileText },
    { id: "skills", path: "/skills", label: t("Skills"), icon: Zap },
    { id: "apps", path: "/apps", label: t("Apps"), icon: AppWindow },
    { id: "schedules", path: "/schedules", label: t("Schedules"), icon: Clock },
    { id: "extensions", path: "/extensions", label: t("Extensions"), icon: Puzzle },
    { id: "whatsapp", path: "/whatsapp", label: "WhatsApp", icon: MessageCircle },
    { id: "sessions", path: "/sessions", label: t("History"), icon: History },
  ];
  const SETTINGS_ITEM: NavItem = {
    id: "settings",
    path: "/settings",
    label: t("Settings"),
    icon: Settings,
  };
  const location = useLocation();
  const demo = useRouteLoaderData("root")?.demo;
  const { loaded, error } = useConversations();
  const [isChatsExpanded, setIsChatsExpanded] = useState(true);
  const isActive = (path: string) => location.pathname === path;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="flex h-full flex-col bg-background-primary outline-none"
    >
      <div className="h-[48px]" />

      <div className="flex flex-col gap-0.5 px-2">
        {NAV_ITEMS.filter(item => !demo || !["recipes", "apps", "schedules"].includes(item.id)).map((item) => (
          <NavRow key={item.id} item={item} active={isActive(item.path)} />
        ))}
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <button
          onClick={() => setIsChatsExpanded((v) => !v)}
          className="flex items-center gap-1 self-start px-4 py-1 text-xs font-semibold uppercase tracking-wider text-text-secondary transition-colors hover:text-text-primary"
        >
          {isChatsExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <span>{t("Chats")}</span>
        </button>
        {isChatsExpanded && (
          <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {conversations.length === 0 ? (
              <div className="px-3 py-2 text-xs text-text-secondary">
                {error ? t(error) : (loaded ? t("No conversations yet") : t("Loading conversations…"))}
              </div>
            ) : (
              conversations.map((c) => (
                <SessionRow
                  key={c.id}
                  conversation={c}
                  active={location.pathname === `/c/${c.id}`}
                />
              ))
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border-secondary px-2 pb-2 pt-2">
        <NavRow item={SETTINGS_ITEM} active={isActive(SETTINGS_ITEM.path)} />
      </div>
    </motion.div>
  );
}
