const { Telegraf } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

async function test() {
  try {
    // Check webhook
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('Webhook URL:', webhookInfo.url || 'NONE');
    console.log('Pending updates:', webhookInfo.pending_update_count);
    console.log('Max connections:', webhookInfo.max_connections);
    
    if (webhookInfo.url) {
      console.log('⚠️ WARNING: Webhook is set! This may intercept updates.');
    }
    
    // Check bot info
    const me = await bot.telegram.getMe();
    console.log('Bot username:', me.username);
    console.log('Bot ID:', me.id);
    
    // Check group info
    try {
      const chat = await bot.telegram.getChat('-1003935328410');
      console.log('Group title:', chat.title);
      console.log('Group type:', chat.type);
      
      // Check bot member status
      const member = await bot.telegram.getChatMember('-1003935328410', me.id);
      console.log('Bot status:', member.status);
      console.log('Can post messages:', member.can_post_messages || 'N/A');
      console.log('Can read messages:', member.can_read_all_group_messages || 'N/A');
    } catch (e) {
      console.error('Group check error:', e.message);
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

test();
