const { Telegraf } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

async function test() {
  try {
    // Get updates directly
    const updates = await bot.telegram.getUpdates({ limit: 10, offset: -10 });
    console.log('Total updates found:', updates.length);
    
    for (const update of updates) {
      console.log('---');
      if (update.message) {
        console.log('Update type: message');
        console.log('Chat type:', update.message.chat.type);
        console.log('Chat ID:', update.message.chat.id);
        console.log('Chat title:', update.message.chat.title || 'N/A');
        console.log('From ID:', update.message.from.id);
        console.log('Text:', update.message.text?.substring(0, 50));
        console.log('Date:', new Date(update.message.date * 1000).toISOString());
      } else {
        console.log('Update type:', Object.keys(update).filter(k => k !== 'update_id'));
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

test();
