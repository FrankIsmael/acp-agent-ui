/**
 * Layout de toda la app. El loader corre en el servidor, así que la lista de
 * conversaciones llega ya renderizada en el HTML.
 */
import { demoUser, conversationOwner } from "~/.server/demo";
import { DemoNotice } from "~/components/DemoNotice";
import { Outlet, useLoaderData } from "react-router";
import { AppLayout } from "~/components/Layout/AppLayout";
import { getHistorySnapshot } from "~/.server/acp";
import { ConversationProvider, useConversations } from "~/components/ConversationContext";
import { ArtifactProvider } from "~/components/artifacts/ArtifactContext";

export async function loader({ request }: { request: Request }) {
  const id = demoUser(request);
  const snapshot = getHistorySnapshot();
  return { ...snapshot, conversations: id ? snapshot.conversations.filter(c => conversationOwner(c.id) === id) : snapshot.conversations };
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
        <div className="flex h-full min-h-0 flex-col">
          <DemoNotice />
          <div className="min-h-0 flex-1"><Outlet /></div>
        </div>
      </AppLayout>
    </ArtifactProvider>
  );
}
