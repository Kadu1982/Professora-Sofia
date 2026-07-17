module.exports = {
  apps: [
    {
      name: 'professora-sofia',
      script: 'server.js',
      cwd: '/var/www/professora-sofia-mvp',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        PORT: 3030,
      },
    },
  ],
};
