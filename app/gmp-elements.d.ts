import type { CSSProperties, Key, ReactNode, Ref } from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'gmp-map': {
        center?: string | { lat: number; lng: number };
        zoom?: string | number;
        'map-id'?: string;
        style?: CSSProperties;
        children?: ReactNode;
        ref?: Ref<HTMLElement>;
      };
      'gmp-advanced-marker': {
        key?: Key;
        position?: { lat: number; lng: number };
        title?: string;
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
