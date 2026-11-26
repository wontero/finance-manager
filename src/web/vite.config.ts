import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const { PORT = "3000" } = loadEnv(mode, root, "PORT");
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
    },
    server: {
      proxy: {
        "/api": "http://127.0.0.1:" + PORT,
        "/auth/google": "http://127.0.0.1:" + PORT,
      },
    },
  };
});
