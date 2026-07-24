import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // External packages that use Node.js APIs — must be excluded from bundling
  serverExternalPackages: ['openai', 'pdf-parse'],
};

export default nextConfig;
