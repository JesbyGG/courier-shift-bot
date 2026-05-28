const { Telegraf } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

console.log('Test bot started. Listening for messages...');

bot.on('message', (ctx) => {
  console.log('=== MESSAGE RECEIVED ===');
  console.log('Chat type:', ctx.chat?.type);
  console.log('Chat ID:', ctx.chat?.id);
  console.log('Chat title:', ctx.chat?.title || 'N/A');
  console.log('From ID:', ctx.from?.id);
  console.log('Text:', ctx.message?.text);
  console.log('=======================');
});

bot.launch();

// Stop after 30 seconds
setTimeout(() => {
  console.log('Stopping test bot...');
  bot.stop();
  process.exit(0);
}, 30000);
