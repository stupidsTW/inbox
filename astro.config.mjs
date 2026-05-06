import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";

export default defineConfig({
  output: "server", // 改為伺服器模式
  adapter: vercel(), // 讓 Vercel 支援 API
});
