#!/usr/bin/env node
// Локален админ панел за статични сайтове (Astro и подобни) — само Node, без инсталации.
// Пускане: node admin.mjs [--port 4870]

import { loadConfig, saveConfig, scanForProjects } from './lib/projects.mjs';
import { startServer } from './server.mjs';

const args = process.argv.slice(2);
let port = 4870;
const pi = args.indexOf('--port');
if (pi !== -1 && args[pi + 1] && /^\d+$/.test(args[pi + 1])) port = parseInt(args[pi + 1], 10);

const config = await loadConfig();

// Автоматично търсене на проекти (Desktop, Documents и др.), при всяко пускане
let found;
try { found = await scanForProjects(config); } catch { found = 0; }
await saveConfig(config);

console.log('');
console.log('  ┌─────────────────────────────────────────────────────┐');
console.log('  │  📝 Локален админ панел                             │');
console.log('  └─────────────────────────────────────────────────────┘');
console.log('');
console.log(`  Отвори в браузъра:  http://localhost:${port}`);
console.log('');
console.log(`  Автоматично намерени проекти: ${found}`);
if (config.projects.length) {
  for (const p of config.projects) console.log(`   • ${p.name}  (${p.path})`);
} else {
  console.log('   (още няма — добави проект с бутон „+ Проект“ в панела)');
}
console.log('');
console.log('  Панелът слуша само на 127.0.0.1 (без достъп от мрежата).');
console.log('  За спиране: Ctrl+C');
console.log('');

try { await startServer(config, port); } catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`  Порт ${port} е зает. Пусни с друг порт: node admin.mjs --port 4871`);
    process.exit(1);
  }
  throw err;
}
