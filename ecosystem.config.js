module.exports = {
  apps: [
    {
      name: "preorder-bot",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 8080,
        TARGET_BASE_URL: "https://thewestern.rdcw.xyz",
        BOT_USERNAME: "TEST4455",
        BOT_PASSWORD: "TEST4455@"
        // PUPPETEER_EXECUTABLE_PATH: "/usr/bin/google-chrome-stable" // Uncomment on Rukcom VPS if Chrome is installed
      }
    }
  ]
};
