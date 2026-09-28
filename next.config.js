/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["whatsapp-web.js", "puppeteer"],
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: "/api/socket",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,OPTIONS" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
