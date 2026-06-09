import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // 2026-06-09 NFT debug: the simple `src-tauri/**` rule wasn't actually
  // keeping NFT from copying the whole src-tauri tree (8.5G of Rust target)
  // into .next/standalone. Trying multiple phrasings — at least one
  // should land in Next 16's minimatch interpretation:
  outputFileTracingExcludes: {
    "*": [
      "src-tauri",
      "src-tauri/**",
      "src-tauri/**/*",
      "**/src-tauri/**",
      "src-tauri/target/**",
      "src-tauri/binaries/**",
      "src-tauri/sidecar/**",
      "src-tauri/gen/**",
      "src-tauri/icons/**",
      "src-tauri/src/**",
      "node_modules/@swc/core-*/**",
      "node_modules/@esbuild/**",
    ],
  },
};

export default nextConfig;
