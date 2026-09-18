import { useLocation } from "react-router";

export const EMBED_PREFIX = "/embed";

/**
 * Las rutas del chat existen dos veces: bajo `/` con el cascarón completo y bajo
 * `/embed` sin barra lateral (para meterlas en un iframe). El hub y el chat
 * navegan entre sí; este prefijo mantiene la navegación dentro del árbol actual.
 */
export function useChatBase(): string {
  const { pathname } = useLocation();
  return pathname === EMBED_PREFIX || pathname.startsWith(`${EMBED_PREFIX}/`) ? EMBED_PREFIX : "";
}
