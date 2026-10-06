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

export {};
