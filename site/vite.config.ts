import { defineConfig } from 'vite';

// Local play against a copy of mainnet: anvil on RPC (default :8547) with the game deployed at GAME.
const RPC = process.env.RPC || 'http://127.0.0.1:8547';

export default defineConfig({
  base: './',
  server: {
    port: 5310,
    proxy: { '/rpc': { target: RPC, changeOrigin: true, rewrite: () => '/' } },
  },
  plugins: [
    {
      name: 'config',
      configureServer(server) {
        server.middlewares.use('/config.json', (_req, res) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ chainId: 1, game: process.env.GAME, end: Number(process.env.END || 1793505600), from: Number(process.env.FROM || 0), fork: true }));
        });
      },
    },
  ],
});
