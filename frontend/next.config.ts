import type { NextConfig } from "next";

/**
 * No bundler configuration is needed. The sealing code in `lib/ecies.ts` uses
 * only Web Crypto and pure-JS primitives, so there are no Node built-ins to
 * polyfill and Turbopack handles it as-is.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
