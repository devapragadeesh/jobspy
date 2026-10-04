import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Resume PDFs are uploaded through a Server Action.
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;
