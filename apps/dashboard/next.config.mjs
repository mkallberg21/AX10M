/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpile the workspace packages we import directly.
  transpilePackages: ['@lift/attribution', '@lift/canonical'],
};

export default nextConfig;
