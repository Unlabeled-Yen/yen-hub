import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // 2026-06-11 — we never use next/image, so the default image-optimization
  // pipeline (which drags in sharp + a 16MB libvips native binary) is dead
  // weight in the bundle. Turn it off and tell NFT not to copy sharp/@img.
  images: { unoptimized: true },
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
      "node_modules/sharp/**",
      "node_modules/@img/**",
    ],
  },
};

export default nextConfig;
