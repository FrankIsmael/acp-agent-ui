/**
 * Layout de toda la app. El loader corre en el servidor, así que la lista de
 * conversaciones llega ya renderizada en el HTML.
 */
import { Outlet, useLoaderData } from "react-router";
import { AppLayout } from "~/components/Layout/AppLayout";
import { getHistorySnapshot } from "~/.server/acp";
import { ConversationProvider, useConversations } from "~/components/ConversationContext";
import { ArtifactProvider } from "~/components/artifacts/ArtifactContext";

export async function loader() {
  return getHistorySnapshot();
}

export default function Shell() {
  const initial = useLoaderData<typeof loader>();
  return <ConversationProvider initial={initial}><ShellContent /></ConversationProvider>;
}

function ShellContent() {
  const { conversations } = useConversations();
  return (
    <ArtifactProvider>
      <AppLayout conversations={conversations}>
        <Outlet />
      </AppLayout>
    </ArtifactProvider>
  );
}
