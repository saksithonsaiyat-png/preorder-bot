ecosystem.config.jsmodule.exports = {
  apps: [
    {
      name: "preorder-bot",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 8080
      }
    }
  ]
};
