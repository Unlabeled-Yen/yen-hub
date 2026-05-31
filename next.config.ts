import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "*": [
      "src-tauri/**",
      "node_modules/@swc/core-*/**",
      "node_modules/@esbuild/**",
    ],
  },
};

export default nextConfig;
