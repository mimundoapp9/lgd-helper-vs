"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;

const vscode = require("vscode");

// Función de activación mínima
function activate(context) {
    console.log('La extensión "lgd-helper" está ahora activa');
    
    // Registrar comandos básicos
    context.subscriptions.push(
        vscode.commands.registerCommand('lgd-helper.startVM', () => {
            vscode.window.showInformationMessage('Iniciando máquina virtual...');
        }),
        vscode.commands.registerCommand('lgd-helper.stopVM', () => {
            vscode.window.showInformationMessage('Deteniendo máquina virtual...');
        })
    );
}
exports.activate = activate;

// Función de desactivación
function deactivate() {}
exports.deactivate = deactivate; 