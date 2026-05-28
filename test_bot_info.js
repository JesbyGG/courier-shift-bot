const { Telegraf } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.telegram.getMe().then(me => {
  console.log('Bot username:', me.username);
  console.log('Bot ID:', me.id);
}).catch(e => {
  console.error('Error:', e.message);
});
