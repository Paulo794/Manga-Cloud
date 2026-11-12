const { spawnSync } = require('node:child_process');
const path = require('node:path');
const command = process.argv[2];
if (!['migrate', 'seed'].includes(command)) throw new Error('Comando de banco inválido.');
const production = process.env.NODE_ENV === 'production';
const file = path.resolve(__dirname, `../${production ? 'dist' : 'src'}/migrations/${command}.${production ? 'js' : 'ts'}`);
const result = spawnSync(process.execPath, [...(production ? [] : ['--import', 'tsx']), file, ...process.argv.slice(3)], { stdio: 'inherit' });
if (result.error) { console.error('Não foi possível iniciar o comando de banco.'); process.exit(1); }
process.exit(result.status ?? 1);
