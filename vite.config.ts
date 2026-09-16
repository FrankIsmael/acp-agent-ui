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
    tailwindcss(), reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
