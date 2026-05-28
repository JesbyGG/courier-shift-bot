const { Telegraf } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// Check if bot can get chat info
async function test() {
  try {
    const chat = await bot.telegram.getChat('-1003935328410');
    console.log('Chat found:', chat.title, chat.type);
    console.log('Bot in chat:', chat.permissions ? 'yes' : 'no');
  } catch (e) {
    console.error('Error:', e.message);
  }
}

test();
