import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // This is a local tool: it reads and writes the user's own filesystem and
  // never talks to a network service. Nothing here enables remote access.
  reactStrictMode: true,
};

export default nextConfig;
