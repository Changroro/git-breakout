import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { historyApiPlugin } from "./server/history-api.ts";

export default defineConfig({
  plugins: [react(), historyApiPlugin()],
});
