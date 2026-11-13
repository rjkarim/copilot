import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Polling: this folder is inside OneDrive, where normal file-change detection
  // is unreliable and the running app could keep showing old code after edits.
  server: { port: 5173, watch: { usePolling: true, interval: 500 } },
});
