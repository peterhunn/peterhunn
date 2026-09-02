/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
  },
  env: {
    ATELIER_API_URL: process.env.ATELIER_API_URL ?? "http://localhost:3001",
  },
};

export default nextConfig;
