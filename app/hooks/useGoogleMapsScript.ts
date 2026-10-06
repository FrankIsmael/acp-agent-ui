import { useEffect, useState } from 'react';

export const useGoogleMapsScript = (apiKey: string) => {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const existingScript = document.querySelector(
      `script[src*="maps.googleapis.com"]`,
    );
    if (!existingScript) {
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=maps`;
      script.async = true;
      script.defer = true;
      script.onload = () => setLoaded(true);
      document.head.appendChild(script);
    } else {
      setLoaded(true);
    }
  }, [apiKey]);

  return loaded;
};
