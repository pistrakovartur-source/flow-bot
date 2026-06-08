module.exports = {
  apps: [{
    name: 'flow-bot',
    script: 'index.js',
    cwd: __dirname,
    env: {
      BOT_TOKEN:    '8257397191:AAGef6Xzyl7SDFMsbdM6y3tHk9xsoCkAZfQ',
      CHAT_ID:      '717571234',
      SYNC_KEY:     'flow2024',
      MORNING_TIME: '09:00',
      EVENING_TIME: '20:00',
      PORT:         '3001',
    },
    restart_delay: 3000,
    max_restarts:  10,
    autorestart:   true,
  }],
}
