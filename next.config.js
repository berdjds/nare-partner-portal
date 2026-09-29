/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["whatsapp-web.js", "puppeteer"],
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
