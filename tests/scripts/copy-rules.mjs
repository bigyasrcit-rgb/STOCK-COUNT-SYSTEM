// firebase-tools requires the rules file inside the firebase.json directory.
// Copy the production rules fresh on every emulator run so tests always exercise the real rules.
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
copyFileSync(join(testsDir, '..', 'firestore.rules'), join(testsDir, 'firestore.rules'));
console.log('copied ../firestore.rules → tests/firestore.rules');
