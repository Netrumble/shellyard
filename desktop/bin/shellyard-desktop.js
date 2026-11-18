#!/usr/bin/env node
// Starts the desktop app and gives the terminal back at once: the app lives in its own window.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Required from plain Node, the electron package exports the path of its binary.
const electron = require('electron');
const app = join(dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
// Set by some tools (VS Code's terminal among them); it would make Electron behave as plain Node.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [app, ...process.argv.slice(2)], { detached: true, stdio: 'ignore', windowsHide: false, env });
child.unref();
