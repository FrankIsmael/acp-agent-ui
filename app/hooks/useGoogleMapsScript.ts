import { useEffect, useState } from 'react';

const isReady = () => !!(window as { google?: { maps?: unknown } }).google?.maps;

// `marker` para los `<gmp-advanced-marker>` del mapa del chat. Un solo <script> por página:
// lo cargue quien lo cargue primero (/gmaps o el chat), lleva las dos librerías.
export const useGoogleMapsScript = (apiKey: string) => {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!apiKey) return;
    if (isReady()) { setLoaded(true); return; }
    let script = document.querySelector<HTMLScriptElement>(`script[src*="maps.googleapis.com"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=maps,marker&loading=async`;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    // El script puede existir y no haber terminado: esperar su `load` en vez de darlo por hecho.
    const onLoad = () => setLoaded(true);
    script.addEventListener('load', onLoad);
    if (isReady()) setLoaded(true);
    return () => script.removeEventListener('load', onLoad);
  }, [apiKey]);

  return loaded;
};
