/**
 * Minimal shell for embedding the chat in another page (iframe): no navigation
 * bar or conversation list, just the hub and thread.
 */
import { Outlet } from 'react-router';
import { DemoNotice } from '~/components/DemoNotice';
import { ArtifactProvider } from '~/components/artifacts/ArtifactContext';

export function meta() {
  return [{ name: 'robots', content: 'noindex' }];
}

export default function Embed() {
  return (
    <ArtifactProvider>
      <div className="flex h-dvh min-h-0 flex-col">
        <DemoNotice />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
    </ArtifactProvider>
  );
}
