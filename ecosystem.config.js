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
    {
      name: 'gemini-ocr-server',
      script: 'gemini_ocr_server.py',
      args: '--server',
      cwd: __dirname,
      interpreter: '/root/ocr_venv/bin/python3',
      interpreter_args: ['-u'],
      autorestart: true,
      max_restarts: 30,
      restart_delay: 5000,
      min_uptime: '10s',
      env: {
        GEMINI_OCR_PORT: '9527',
      },
    },
  ],
};
