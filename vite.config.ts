import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "demo-client-ip",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          // Vite development server trusts only its TCP peer, never forwarding headers.
          request.headers["x-demo-client-ip"] = request.socket.remoteAddress ?? "";
          next();
        });
      },
    },
    {
      name: "slack-on-boot",
      configureServer(server) {
        // The app's server code only loads on the first request; Slack has to be up before
        // anyone opens a page (server.js does the same in production). acp.ts starts it when it
        // loads; going through slack.ts first would run startSlack before slack.ts finished.
        if (!process.env.SLACK_BOT_TOKEN) return;
        server.httpServer?.once("listening", () => {
          server
            .ssrLoadModule("/app/.server/acp.ts")
            .catch((error) => console.warn("[slack] could not load:", error.message));
        });
      },
    },
    tailwindcss(), reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
