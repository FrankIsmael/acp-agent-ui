/**
 * Layout de toda la app. El loader corre en el servidor, así que la lista de
 * conversaciones llega ya renderizada en el HTML.
 */
import { Outlet, useLoaderData } from "react-router";
import { AppLayout } from "~/components/Layout/AppLayout";
import { listConversations } from "~/.server/acp";
import { ArtifactProvider } from "~/components/artifacts/ArtifactContext";

export async function loader() {
  return { conversations: listConversations() };
}

export default function Shell() {
  const { conversations } = useLoaderData<typeof loader>();
  return (
    <ArtifactProvider>
      <AppLayout conversations={conversations}>
        <Outlet />
      </AppLayout>
    </ArtifactProvider>
  );
}
