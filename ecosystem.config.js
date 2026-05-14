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
        RAPIDOCR_URL: 'http://127.0.0.1:9527',
      },
    },
    {
      name: 'rapidocr-server',
      script: 'rapidocr_server.py',
      args: '--server',
      interpreter: './venv/bin/python',
      interpreter_args: '',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      min_uptime: '5s',
      env: {
        RAPIDOCR_PORT: '9527',
        OCR_MIN_MILEAGE: '1000',
        RAPIDOCR_MIN_COUNT: '1',
        RAPIDOCR_MIN_AVG_CONF: '0.55',
        RAPIDOCR_MIN_MAX_CONF: '0.68',
      },
    },
  ],
};