/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpile the workspace packages we import directly.
  transpilePackages: ['@lift/attribution', '@lift/canonical', '@lift/onboarding'],
  webpack: (config) => {
    // The monorepo uses NodeNext-style explicit `.js` import specifiers (which
    // point at `.ts`/`.tsx` source). tsc resolves these; teach webpack to as well.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
