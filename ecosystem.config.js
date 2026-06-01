module.exports = {
  apps: [
    {
      name: 'courier-shift-bot',
      script: 'bot.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 30,
      restart_delay: 5000,
      min_uptime: '10s',
      wait_ready: false,
      listen_timeout: 30000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
