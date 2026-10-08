import { useLoaderData } from 'react-router';
import { MainPanelLayout } from '~/components/Layout/MainPanelLayout';
import { useGoogleMapsScript } from '~/hooks/useGoogleMapsScript';

export async function clientLoader() {
  return { apiKey: window.ENV?.GOOGLE_MAPS_KEY };
}

export function HydrateFallback() {
  return <div>Loading map system dynamically...</div>;
}

export default function GMaps() {
  const { apiKey } = useLoaderData<typeof clientLoader>();

  const loaded = useGoogleMapsScript(apiKey ?? '');

  if (!loaded) return <div>Loading Map ...</div>;
  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl overflow-y-auto px-6 py-10">
        <div className="max-h-full bg-amber-300 font-extrabold">GMaps</div>
        <div style={{ height: '400px', width: '100%' }}>
          <gmp-map
            center={{ lat: 38.7946, lng: -106.5348 }}
            zoom={4}
            map-id="DEMO_MAP_ID"
            style={{ height: '100%' }}
          ></gmp-map>
        </div>
      </div>
    </MainPanelLayout>
  );
}
