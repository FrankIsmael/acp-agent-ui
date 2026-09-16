/**
 * Servidor Express — SSR de React Router en producción.
 *
 *   npm run build && node server.js
 *
 * En desarrollo no se usa: `npm run dev` levanta Vite con su propio middleware.
 */
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import morgan from "morgan";

const PORT = Number(process.env.PORT ?? 3000);
const app = express();

app.use(compression());
app.disable("x-powered-by");
// En producción la app va detrás de Caddy (TLS terminado ahí). Sin esto Express cree que
// habla http y `request.url` sale con el esquema equivocado: la comprobación de mismo
// origen rechazaba el POST del propio navegador con 403.
// Never trust arbitrary forwarding headers for demo limits. List only actual proxy
// IPs/CIDRs; with no configuration, use the TCP peer (safe for direct hosting).
const demoProxies = (process.env.DEMO_TRUSTED_PROXIES ?? "").split(",").map(value => value.trim()).filter(Boolean);
app.set("trust proxy", process.env.PUBLIC_DEMO === "true" ? (demoProxies.length ? demoProxies : false) : true);
app.use((request, _response, next) => {
  // Always replace a visitor-supplied value before React Router sees the request.
  request.headers["x-demo-client-ip"] = request.ip ?? request.socket.remoteAddress ?? "";
  next();
});

app.use(
  "/assets",
  express.static("build/client/assets", { immutable: true, maxAge: "1y" })
);
app.use(express.static("build/client", { maxAge: "1h" }));
app.use(morgan("tiny"));

// Express 5 ya no acepta "*" como ruta (path-to-regexp 8 exige nombre en el
// comodín); `use` sin ruta atrapa todo lo que no fue estático, que es lo mismo.
app.use(
  createRequestHandler({
    build: () => import("./build/server/index.js"),
  })
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[web3] http://localhost:${PORT}`);
});
