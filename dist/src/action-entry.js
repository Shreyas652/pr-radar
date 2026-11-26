import { command, runAction } from './action.js';
runAction(process.env).then((code) => {
    process.exitCode = code;
}, (err) => {
    process.stdout.write(`${command('error', `pr-radar failed: ${err instanceof Error ? err.message : String(err)}`)}\n`);
    process.exitCode = 1;
});
