const { Telegraf } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

async function test() {
  try {
    // Get bot info
    const me = await bot.telegram.getMe();
    console.log('Bot username:', me.username);
    console.log('Bot ID:', me.id);
    
    // Check if we can get updates (this will tell us if polling is working)
    const updates = await bot.telegram.getUpdates({ limit: 1 });
    console.log('Pending updates:', updates.length);
    
    if (updates.length > 0) {
      console.log('Last update type:', updates[0].message ? 'message' : 'other');
      if (updates[0].message) {
        console.log('Last update chat type:', updates[0].message.chat.type);
        console.log('Last update text:', updates[0].message.text?.substring(0, 30));
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

test();
