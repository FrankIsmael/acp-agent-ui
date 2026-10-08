import type { CSSProperties, ReactNode } from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'gmp-map': {
        center?: string;
        zoom?: string;
        'map-id'?: string;
        style?: CSSProperties;
        children?: ReactNode;
      };
    }
  }
}

declare global {
  interface Window {
    // Injected by app/root.tsx.
    ENV?: { GOOGLE_MAPS_KEY?: string };
  }
}

export {};
