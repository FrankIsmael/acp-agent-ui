import { consumeDemoIp } from "./demo-ip";
import type { MiddlewareFunction } from "react-router";
import { assertSameOrigin } from "./request-validation";
import { assertDemoOwner, demoDb, demoEnabled, DemoLimitError, identifyDemo } from "./demo";

/** One removable boundary for every page, resource route, and SSE connection. */
export const demoMiddleware: MiddlewareFunction<Response> = async ({ request, params }, next) => {
  if (!demoEnabled()) return next();
  try {
    if (!["GET", "HEAD"].includes(request.method)) assertSameOrigin(request);
    const path = new URL(request.url).pathname.replace(/\.data$/, "").replace(/\/$/, "") || "/";
    // Default-deny future endpoints until they explicitly join the demo surface.
    const allowed = /^(?:\/|\/_root|\/c\/(?:nuevo|[^/]+)|\/skills|\/extensions|\/artifacts|\/sessions|\/settings|\/whatsapp|\/api\/demo|\/api\/whatsapp(?:\/events)?|\/api\/conversations(?:\/[^/]+\/(?:events|messages|cancel|close|permissions))?)$/;
    if (!allowed.test(path)) return Response.json({ error: "Esta sección no está disponible en la demo." }, { status: 403 });
    if (path.startsWith("/api/")) consumeDemoIp(demoDb(), request, "api");
    const identity = identifyDemo(request, () => consumeDemoIp(demoDb(), request, "guests"));
    if (params.id) assertDemoOwner(identity.id!, params.id);
    if (request.method === "POST" && (path === "/api/conversations" || /^\/api\/conversations\/[^/]+\/messages$/.test(path))) {
      consumeDemoIp(demoDb(), request, "chat");
    }
    const response = await next();
    response.headers.set("Cache-Control", "private, no-store");
    if (identity.cookie) response.headers.append("Set-Cookie", identity.cookie);
    return response;
  } catch (error) {
    if (error instanceof Response && error.status === 429) return error;
    if (error instanceof DemoLimitError) return Response.json({ error: error.message, code: "DEMO_LIMIT" }, { status: 429 });
    throw error;
  }
};
