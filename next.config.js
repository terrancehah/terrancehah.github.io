/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  images: {
    domains: ['places.googleapis.com'],
  },
  experimental: {
    missingSuspenseWithCSRError: false
  }
}

module.exports = nextConfig