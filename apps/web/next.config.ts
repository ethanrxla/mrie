import type { NextConfig } from "next";
import path from "node:path";

const appRoot = process.cwd();
const isRepositoryApp =
  path.basename(appRoot).toLowerCase() === "web" &&
  path.basename(path.dirname(appRoot)).toLowerCase() === "apps";
const workspaceRoot = isRepositoryApp ? path.resolve(appRoot, "../..") : appRoot;

const nextConfig: NextConfig = {
  turbopack: {
    root: workspaceRoot,
  },
  outputFileTracingRoot: workspaceRoot,
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    cpus: 1,
    optimizePackageImports: ["lucide-react", "framer-motion"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; media-src 'self' blob: data:; worker-src 'self' blob:; upgrade-insecure-requests",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
