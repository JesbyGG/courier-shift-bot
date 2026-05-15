#!/bin/bash
set -e

echo "========================================="
echo "  Courier Shift Bot - VPS Setup Script"
echo "========================================="
echo ""

# 1. Update system
echo "[1/10] Updating system packages..."
apt-get update && apt-get upgrade -y

# 2. Install Node.js 24
echo "[2/10] Installing Node.js 24..."
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

# 3. Install Python, pip, git, build tools
echo "[3/10] Installing Python, pip, git..."
apt-get install -y python3 python3-pip python3-venv git build-essential libgl1 libglib2.0-0

# 4. Install PM2 globally
echo "[4/10] Installing PM2..."
npm install -g pm2

# 5. Clone repository
echo "[5/10] Cloning repository..."
cd ~
git clone https://github.com/JesbyGG/courier-shift-bot.git
cd courier-shift-bot

# 6. Install npm dependencies
echo "[6/10] Installing npm dependencies..."
npm install --production

# 7. Create Python virtual environment and install RapidOCR
echo "[7/10] Installing RapidOCR..."
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install rapidocr[onnxruntime] numpy opencv-python-headless pillow

# 8. Create .env from example
echo "[8/10] Creating .env file..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo ">>> IMPORTANT: Edit .env and fill in your tokens!"
    echo ">>> Run: nano .env"
fi

# 9. Setup PM2
echo "[9/10] Setting up PM2..."
pm2 start ecosystem.config.js
pm2 save
pm2 startup

# 10. Configure firewall
echo "[10/10] Configuring firewall..."
ufw allow ssh
ufw --force enable

echo ""
echo "========================================="
echo "  Setup complete!"
echo "========================================="
echo ""
echo "NEXT STEPS:"
echo "1. Edit .env: nano .env"
echo "   Fill in: BOT_TOKEN, GOOGLE_SHEET_ID, GOOGLE_PRIVATE_KEY, etc."
echo "2. Restart bot: pm2 restart courier-shift-bot"
echo "3. Check status: pm2 status"
echo "4. Check logs: pm2 logs courier-shift-bot"
echo ""
