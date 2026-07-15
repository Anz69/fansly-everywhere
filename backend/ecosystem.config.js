// PM2 process configuration
// Env vars loaded from /app/.env
// Deploy: set -a && source /app/.env && set +a && pm2 start ecosystem.config.js && pm2 save

module.exports = {
  apps: [
    {
      name: "fan-api",
      script: "/app/api/index.mjs",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 4000,
        BASE_PATH: "/api",
        DATABASE_URL: process.env.DATABASE_URL || "",
        // FANDB_URL is required by session.ts for session lookups
        FANDB_URL: process.env.FANDB_URL || process.env.DATABASE_URL || "",
        SESSION_SECRET: process.env.SESSION_SECRET || "",
        ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || "",
        ADMIN_TELEGRAM_IDS: process.env.ADMIN_TELEGRAM_IDS || "",
        CORS_ORIGINS: process.env.CORS_ORIGINS || "",
      },
      max_memory_restart: "300M",
      error_file: "/app/logs/fan-api-error.log",
      out_file: "/app/logs/fan-api-out.log",
      merge_logs: true,
    },
    {
      name: "auth-bot",
      script: "/app/auth-bot.mjs",
      env: {
        NODE_ENV: "production",
        BOT_TOKEN: process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "",
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || "",
        BACKUP_BOT_TOKEN: process.env.BACKUP_BOT_TOKEN || "",
        DATABASE_URL: process.env.DATABASE_URL || "",
        ADMIN_TELEGRAM_IDS: process.env.ADMIN_TELEGRAM_IDS || "",
      },
      max_memory_restart: "200M",
      error_file: "/app/logs/auth-bot-error.log",
      out_file: "/app/logs/auth-bot-out.log",
      merge_logs: true,
      restart_delay: 3000,
    },
    {
      name: "mtproto-auth",
      script: "/app/mtproto-auth.mjs",
      env: {
        NODE_ENV: "production",
        DATABASE_URL: process.env.DATABASE_URL || "",
        TELEGRAM_API_ID: process.env.TELEGRAM_API_ID || "",
        TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH || "",
        BOT_TOKEN: process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "",
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || "",
        BACKUP_BOT_TOKEN: process.env.BACKUP_BOT_TOKEN || "",
        AUTHORIZED_ADMIN_IDS: process.env.AUTHORIZED_ADMIN_IDS || "",
      },
      max_memory_restart: "600M",
      error_file: "/app/logs/mtproto-error.log",
      out_file: "/app/logs/mtproto-out.log",
      merge_logs: true,
      restart_delay: 3000,
    },
  ],
};
