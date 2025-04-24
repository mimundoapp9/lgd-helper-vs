import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

let outputChannel: vscode.OutputChannel;
let isDebugging = false; // Flag para modo debug

// Constante para el directorio de vagrant
const VAGRANT_DIR = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.replace(/\/dev$/, '') || process.cwd();

// Al inicio del archivo, después de las interfaces
let containerPorts: Map<string, string[]> = new Map();

// Primero definimos una interfaz para el tipo de configuración
interface WorkspaceConfig {
    folders: Array<{
        path: string;
        name?: string;
    }>;
    settings: {
        [key: string]: any;
    };
}

// Función helper para logging que solo funciona en modo debug
function debugLog(message: string) {
    if (isDebugging && outputChannel) {
        const timestamp = new Date().toISOString();
        outputChannel.appendLine(`[${timestamp}] ${message}`);
        outputChannel.show(true); // Forzar mostrar el panel
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Iniciando activación de extensión LGD Helper');

    // Crear el canal de salida para debugging
    outputChannel = vscode.window.createOutputChannel('LGD Helper');
    outputChannel.appendLine('Iniciando activación de extensión');

    try {
        // Registrar el WebviewViewProvider
        console.log('Registrando WebviewViewProvider');
        const provider = new LGDViewProvider(context);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('lgdView', provider)
        );
        outputChannel.appendLine('WebviewViewProvider registrado');

        // Registrar comandos
        let commands = [
            vscode.commands.registerCommand('lgd-helper.startVM', () => {
                executeVagrantCommand('up', '🚀 Iniciando máquina virtual...');
            }),
            vscode.commands.registerCommand('lgd-helper.stopVM', () => {
                executeVagrantCommand('halt', '🛑 Deteniendo máquina virtual...');
            }),
            vscode.commands.registerCommand('lgd-helper.checkStatus', async () => {
                try {
                    debugLog('Verificando estado de la máquina virtual...');

                    // Ejecutar vagrant status y capturar la salida
                    const output = await executeCommand('vagrant status');
                    debugLog(`Salida completa:\n${output}`);

                    // Buscar el estado en la salida
                    const isRunning = output.toLowerCase().includes('running');
                    const isPoweroff = output.toLowerCase().includes('poweroff');
                    const isNotCreated = output.toLowerCase().includes('not created');

                    // Determinar el estado y mostrar el mensaje apropiado
                    if (isRunning) {
                        vscode.window.showInformationMessage('✅ La máquina virtual está corriendo');
                        return true;
                    } else if (isPoweroff) {
                        vscode.window.showWarningMessage('⚠️ La máquina virtual está apagada');
                        return false;
                    } else if (isNotCreated) {
                        vscode.window.showErrorMessage('❌ La máquina virtual no está creada');
                        return false;
                    } else {
                        vscode.window.showWarningMessage('❓ Estado desconocido de la máquina virtual');
                        return false;
                    }
                } catch (error) {
                    debugLog(`Error al verificar estado: ${error}`);
                    vscode.window.showErrorMessage(`❌ Error al verificar estado: ${error}`);
                    return false;
                }
            }),
            vscode.commands.registerCommand('lgd-helper.showDebugLogs', () => {
                showDebugLogs();
            }),
            vscode.commands.registerCommand('lgd-helper.createWorkspace', async () => {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspaceRoot) {
                    vscode.window.showErrorMessage('No hay un workspace abierto');
                    return;
                }

                // Asegurarse de que estamos en la raíz (donde está el Vagrantfile) y no en /dev
                const rootPath = workspaceRoot.endsWith('/dev')
                    ? path.dirname(workspaceRoot)
                    : workspaceRoot;

                const devPath = path.join(rootPath, 'dev');
                debugLog(`Intentando crear workspace con rootPath: ${rootPath}, devPath: ${devPath}`);

                try {
                    const workspacePath = await createWorkspace(devPath);
                    debugLog(`Workspace creado exitosamente en: ${workspacePath}`);

                    const uri = vscode.Uri.file(workspacePath);
                    await vscode.commands.executeCommand('vscode.openFolder', uri);

                    vscode.window.showInformationMessage('Workspace creado exitosamente');
                } catch (error) {
                    debugLog(`Error detallado: ${error}`);
                    vscode.window.showErrorMessage(`Error al crear el workspace: ${error.message}`);
                }
            }),
            vscode.commands.registerCommand('lgd-helper.updateOdooModule', updateOdooModule),
            vscode.commands.registerCommand('lgd-helper.installOdooModule', installOdooModule),
            vscode.commands.registerCommand('lgd-helper.showOdooContainerLogs', showOdooContainerLogs)
        ];

        context.subscriptions.push(...commands);
        outputChannel.appendLine('Comandos registrados');
        outputChannel.appendLine('Activación completada');
    } catch (error) {
        outputChannel.appendLine(`Error durante la activación: ${error}`);
        console.error('Error durante la activación:', error);
    }
}

function executeVagrantCommand(command: string, message: string) {
  debugLog(`Ejecutando vagrant ${command} en ${VAGRANT_DIR}`);

  // Crear un terminal oculto
  const terminal = vscode.window.createTerminal({
    name: "LGD – VM",
    cwd: VAGRANT_DIR,
    shellPath: '/bin/zsh',
    env: {
      TERM: 'xterm-256color'
    },
    hideFromUser: true // Ocultar la terminal
  });

  // Ejecutar el comando
  terminal.sendText(`vagrant ${command}`);

  // Mostrar mensaje de información
  // vscode.window.showInformationMessage(message);

  // Opcionalmente, podemos cerrar la terminal después de un tiempo
  setTimeout(() => {
    terminal.dispose();
  }, 60000); // Cerrar después de 1 minuto (ajustar según sea necesario)
}

class LGDViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _vmStatus: string = 'unknown'; // Estado inicial desconocido

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri
      ]
    };

    // Verificar estado inicial
    this._checkAndUpdateStatus();

    webviewView.webview.html = this._getHtmlContent();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'startVM':
          executeVagrantCommand('up', '🚀 Iniciando máquina virtual...');
          // Actualizar estado después de un tiempo
          setTimeout(() => this._checkAndUpdateStatus(), 5000);
          break;
        case 'stopVM':
          executeVagrantCommand('halt', '🛑 Deteniendo máquina virtual...');
          // Actualizar estado después de un tiempo
          setTimeout(() => this._checkAndUpdateStatus(), 5000);
          break;
        case 'showDebugLogs':
          showDebugLogs();
          break;
        case 'updateOdooModule':
          updateOdooModule();
          break;
        case 'installOdooModule':
          installOdooModule();
          break;
        case 'showOdooContainerLogs':
          showOdooContainerLogs();
          break;
      }
    });
  }

  // Método para verificar y actualizar el estado
  private async _checkAndUpdateStatus() {
    try {
      const output = await executeCommand('vagrant status');

      if (output.toLowerCase().includes('running')) {
        this._vmStatus = 'running';
      } else if (output.toLowerCase().includes('poweroff')) {
        this._vmStatus = 'stopped';
      } else if (output.toLowerCase().includes('not created')) {
        this._vmStatus = 'not-created';
      } else {
        this._vmStatus = 'unknown';
      }

      // Actualizar la UI
      if (this._view) {
        this._view.webview.html = this._getHtmlContent();
      }
    } catch (error) {
      this._vmStatus = 'error';
      if (this._view) {
        this._view.webview.html = this._getHtmlContent();
      }
    }
  }

  private _getHtmlContent(): string {
    // Determinar el texto y estilo del indicador de estado
    let statusText = '';
    let statusClass = '';

    switch (this._vmStatus) {
      case 'running':
        statusText = '✅ Máquina Virtual: ACTIVA';
        statusClass = 'status-running';
        break;
      case 'stopped':
        statusText = '⚠️ Máquina Virtual: DETENIDA';
        statusClass = 'status-stopped';
        break;
      case 'not-created':
        statusText = '❌ Máquina Virtual: NO CREADA';
        statusClass = 'status-error';
        break;
      case 'error':
        statusText = '❌ Error al verificar estado';
        statusClass = 'status-error';
        break;
      default:
        statusText = '❓ Estado: Desconocido';
        statusClass = 'status-unknown';
    }

    return `
      <!DOCTYPE html>
      <html lang="es">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>LGD Tools</title>
          <style>
            body {
              font-family: var(--vscode-font-family);
              padding: 1rem;
              color: var(--vscode-foreground);
            }
            button {
              width: 100%;
              padding: 8px 12px;
              margin-bottom: 10px;
              background: var(--vscode-button-background);
              color: var(--vscode-button-foreground);
              border: none;
              border-radius: 2px;
              cursor: pointer;
            }
            button:hover {
              background: var(--vscode-button-hoverBackground);
            }
            .stop-button {
              background: var(--vscode-errorForeground);
            }
            .section {
              margin-bottom: 20px;
              padding: 10px;
              border: 1px solid var(--vscode-panel-border);
              border-radius: 4px;
            }
            .status-indicator {
              padding: 8px;
              margin-bottom: 10px;
              border-radius: 4px;
              text-align: center;
              font-weight: bold;
            }
            .status-running {
              background-color: rgba(0, 128, 0, 0.2);
              color: var(--vscode-terminal-ansiGreen);
            }
            .status-stopped {
              background-color: rgba(255, 165, 0, 0.2);
              color: var(--vscode-terminal-ansiYellow);
            }
            .status-error {
              background-color: rgba(255, 0, 0, 0.2);
              color: var(--vscode-terminal-ansiRed);
            }
            .status-unknown {
              background-color: rgba(128, 128, 128, 0.2);
              color: var(--vscode-terminal-ansiBrightBlack);
            }
          </style>
        </head>
        <body>
          <div class="section">
            <div class="status-indicator ${statusClass}">
              ${statusText}
            </div>
            <button onclick="checkStatus()">🔍 Verificar Estado</button>
            <button onclick="startVM()">✨ Iniciar Máquina Virtual</button>
            <button onclick="stopVM()" class="stop-button">🛑 Detener Máquina Virtual</button>
          </div>

          <div class="section">
            <h3>🗄️ Base de Datos</h3>
            <button onclick="showDatabases()">💾 Gestionar bases de datos</button>
          </div>

          <div class="section">
            <h3>🦊 Odoo</h3>
            <button onclick="updateOdooModule()">🔄 Actualizar módulo</button>
            <button onclick="installOdooModule()">📦 Instalar módulo</button>
            <button onclick="showOdooContainerLogs()"> Ver logs</button>
          </div>

          <script>
            const vscode = acquireVsCodeApi();

            function startVM() {
              vscode.postMessage({ command: 'startVM' });
            }

            function stopVM() {
              vscode.postMessage({ command: 'stopVM' });
            }

            function showDatabases() {
              vscode.postMessage({ command: 'showDatabases' });
            }

            function updateOdooModule() {
              vscode.postMessage({ command: 'updateOdooModule' });
            }

            function installOdooModule() {
              vscode.postMessage({ command: 'installOdooModule' });
            }

            function showOdooContainerLogs() {
              vscode.postMessage({ command: 'showOdooContainerLogs' });
            }

            function checkStatus() {
              vscode.postMessage({ command: 'checkStatus' });
            }

            // Verificar estado automáticamente cada 30 segundos
            setInterval(() => {
              vscode.postMessage({ command: 'checkStatus' });
            }, 30000);
          </script>
        </body>
      </html>
    `;
  }
}

export function deactivate() {}

// Función modificada para ejecutar comandos
async function executeCommand(command: string): Promise<string> {
    debugLog(`Ejecutando comando: ${command} en directorio: ${VAGRANT_DIR}`);
    return new Promise((resolve, reject) => {
        exec(command, {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            cwd: VAGRANT_DIR // Especificar el directorio de trabajo
        }, (error, stdout, stderr) => {
            if (error) {
                debugLog(`Error en comando: ${error.message}`);
                debugLog(`stderr: ${stderr}`);
                reject(error);
                return;
            }
            debugLog(`stdout: ${stdout}`);
            resolve(stdout);
        });
    });
}

// Función para mostrar bases de datos
async function showDatabases() {
  if (!(await ensureVagrantRunning())) {
    return;
  }
  try {
    const output = await executeCommand('vagrant ssh -c "docker exec ldb psql -U odoo -l"');
    const databases = parseDatabases(output);
    showDatabaseList(databases);
  } catch (error) {
    vscode.window.showErrorMessage(`Error al listar bases de datos: ${error}`);
  }
}

// Parsear lista de bases de datos
function parseDatabases(output: string): string[] {
  return output.split('\n')
    .filter(line => line.trim() && !line.startsWith('-') && !line.includes('template'))
    .map(line => line.split('|')[0].trim());
}

// Mostrar lista de bases de datos
async function showDatabaseList(databases: string[]) {
  const selected = await vscode.window.showQuickPick(databases, {
    placeHolder: 'Selecciona una base de datos'
  });

  if (selected) {
    const action = await vscode.window.showQuickPick(['Ver detalles', 'Eliminar'], {
      placeHolder: `¿Qué deseas hacer con ${selected}?`
    });

    if (action === 'Eliminar') {
      await deleteDatabase(selected);
    }
  }
}

// Eliminar base de datos
async function deleteDatabase(dbName: string) {
  if (!(await ensureVagrantRunning())) {
    return;
  }
  try {
    await executeCommand(`vagrant ssh -c "docker stop ${dbName}"`);
    await executeCommand(`vagrant ssh -c "docker exec ldb dropdb -U odoo --if-exists ${dbName}"`);
    vscode.window.showInformationMessage(`Base de datos ${dbName} eliminada`);
  } catch (error) {
    vscode.window.showErrorMessage(`Error al eliminar base de datos: ${error}`);
  }
}

function showDebugLogs() {
  outputChannel.show(true); // true para forzar el foco
  outputChannel.appendLine('='.repeat(50));
  outputChannel.appendLine(`[${new Date().toISOString()}] Iniciando sesión de logs`);

  // Mostrar información del sistema
  outputChannel.appendLine('Información del sistema:');
  outputChannel.appendLine(`- VS Code versión: ${vscode.version}`);
  outputChannel.appendLine(`- Extensión versión: ${vscode.extensions.getExtension('mimundoapp9.lgd-helper')?.packageJSON.version}`);
  outputChannel.appendLine('='.repeat(50));
}

// Función para crear el workspace
async function createWorkspace(devPath: string): Promise<string> {
    try {
        const workspaceRoot = path.dirname(devPath);

        // Verificar que existe el Vagrantfile en la raíz
        const vagrantFilePath = path.join(workspaceRoot, 'Vagrantfile');
        if (!fs.existsSync(vagrantFilePath)) {
            debugLog(`No se encontró Vagrantfile en ${workspaceRoot}`);
            throw new Error('No se encontró Vagrantfile en el directorio raíz');
        }

        // Verificar que existe la carpeta dev
        if (!fs.existsSync(devPath) || !fs.statSync(devPath).isDirectory()) {
            debugLog(`La carpeta dev no existe en ${workspaceRoot}`);
            throw new Error('No se encontró la carpeta dev');
        }

        const rootName = path.basename(workspaceRoot);
        debugLog(`Creando workspace para ${rootName} con devPath: ${devPath}`);

        // Obtener archivos y carpetas de dev
        const devItems = fs.readdirSync(devPath).map(item => ({
            fullPath: path.join(devPath, item),
            name: item,
            isDirectory: fs.statSync(path.join(devPath, item)).isDirectory()
        }));

        // Obtener archivos de la raíz (vm)
        const rootItems = fs.readdirSync(workspaceRoot).map(item => ({
            fullPath: path.join(workspaceRoot, item),
            name: item,
            isDirectory: fs.statSync(path.join(workspaceRoot, item)).isDirectory()
        }));

        // Separar carpetas y archivos
        const devFolders = devItems
            .filter(item => item.isDirectory)
            .map(folder => ({
                path: path.join('dev', folder.name),
                name: folder.name
            }));

        const workspaceContent: WorkspaceConfig = {
            folders: [
                // Carpeta dev como raíz
                {
                    path: "dev",
                    name: "dev"
                },
                // Todas las carpetas dentro de dev
                ...devFolders,
                // Carpeta especial para archivos de dev
                {
                    path: "dev",
                    name: "📄 Archivos dev"
                },
                // Carpeta para archivos de la raíz
                {
                    path: ".",
                    name: "📄 Archivos vm"
                }
            ],
            settings: {
                "search.followSymlinks": false,
                "esbonio.sphinx.confDir": "",
                // Configuraciones para mostrar/ocultar archivos
                "files.exclude": {
                    // Ocultar carpetas en la vista de archivos dev
                    ...devFolders.reduce((acc, folder) => ({
                        ...acc,
                        [`dev/${folder.name}`]: true
                    }), {}),
                    // Ocultar carpetas en la vista de archivos vm
                    ...rootItems
                        .filter(item => item.isDirectory && item.name !== 'dev')
                        .reduce((acc, folder) => ({
                            ...acc,
                            [folder.name]: true
                        }), {})
                },
                // Configuraciones específicas para cada vista
                [`files.exclude.${rootName}/dev`]: {
                    "**/": false,
                    ...devFolders.reduce((acc, folder) => ({
                        ...acc,
                        [folder.name]: true
                    }), {})
                },
                [`files.exclude.${rootName}`]: {
                    "**/": false,
                    "dev": true,
                    ...rootItems
                        .filter(item => item.isDirectory)
                        .reduce((acc, folder) => ({
                            ...acc,
                            [folder.name]: true
                        }), {})
                }
            }
        };

        const workspacePath = path.join(workspaceRoot, `${rootName}.code-workspace`);
        fs.writeFileSync(workspacePath, JSON.stringify(workspaceContent, null, 2));

        return workspacePath;
    } catch (error) {
        debugLog(`Error al crear workspace: ${error}`);
        throw error;
    }
}

// Función para validar la estructura del workspace
async function validateWorkspaceStructure() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        return; // No hay workspace abierto
    }

    debugLog(`Validando estructura del workspace: ${workspaceRoot}`);

    // Verificar si estamos en la carpeta dev
    const isInDevFolder = workspaceRoot.endsWith('/dev');

    // Verificar si hay un Vagrantfile en el directorio actual o en el padre (si estamos en dev)
    const vagrantFilePath = isInDevFolder
        ? path.join(path.dirname(workspaceRoot), 'Vagrantfile')
        : path.join(workspaceRoot, 'Vagrantfile');

    const vagrantFileExists = fs.existsSync(vagrantFilePath);

    debugLog(`¿Estamos en carpeta dev? ${isInDevFolder}`);
    debugLog(`¿Existe Vagrantfile? ${vagrantFileExists} (buscado en ${vagrantFilePath})`);

    // Si estamos en dev pero no hay Vagrantfile en el directorio padre
    if (isInDevFolder && !vagrantFileExists) {
        const message = 'Estás trabajando dentro de la carpeta "dev". Para un funcionamiento óptimo, abre el workspace en la carpeta raíz que contiene el Vagrantfile.';
        const action = await vscode.window.showWarningMessage(message, 'Abrir carpeta raíz', 'Ignorar');

        if (action === 'Abrir carpeta raíz') {
            const parentUri = vscode.Uri.file(path.dirname(workspaceRoot));
            await vscode.commands.executeCommand('vscode.openFolder', parentUri);
        }
    }
    // Si no estamos en dev y no hay Vagrantfile
    else if (!isInDevFolder && !vagrantFileExists) {
        // Buscar si hay una carpeta dev
        const devFolderPath = path.join(workspaceRoot, 'dev');
        const devFolderExists = fs.existsSync(devFolderPath) && fs.statSync(devFolderPath).isDirectory();

        if (!devFolderExists) {
            vscode.window.showErrorMessage('Esta extensión requiere un Vagrantfile en la raíz y una carpeta "dev". La estructura actual no es compatible.');
        }
    }
}

// Función para mostrar los logs de un contenedor Odoo
async function showOdooContainerLogs() {
  debugLog('Iniciando función showOdooContainerLogs');

  if (!(await ensureVagrantRunning())) {
    debugLog('La máquina virtual no está corriendo');
    return;
  }

  try {
    // 1. Obtener lista de contenedores Odoo
    debugLog('Obteniendo lista de contenedores Odoo');
    const output = await executeCommand('vagrant ssh -c "docker ps --format \'{{.Names}}|{{.Image}}\'"');
    const containers = output.split('\n')
      .filter(line => line.trim())
      .filter(line => {
        const [_, image] = line.split('|');
        // Filtrar solo contenedores que probablemente sean de Odoo
        return image && (
          image.toLowerCase().includes('odoo') ||
          image.toLowerCase().includes('dashboard') ||
          image.toLowerCase().includes('control')
        );
      })
      .map(line => line.split('|')[0].trim());

    debugLog(`Contenedores Odoo encontrados: ${containers.join(', ')}`);

    if (containers.length === 0) {
      vscode.window.showInformationMessage('No se encontraron contenedores de Odoo');
      return;
    }

    // 2. Seleccionar contenedor
    const selectedContainer = await vscode.window.showQuickPick(containers, {
      placeHolder: 'Selecciona un contenedor para ver sus logs'
    });

    if (!selectedContainer) {
      debugLog('Usuario canceló la selección de contenedor');
      return;
    }

    debugLog(`Contenedor seleccionado: ${selectedContainer}`);

    // 3. Crear terminal para mostrar los logs
    const terminal = vscode.window.createTerminal(`Logs: ${selectedContainer}`);
    terminal.show();

    // Comando para mostrar los logs
    const logsCommand = `"docker logs -f ${selectedContainer}"`;

    debugLog(`Ejecutando comando: vagrant ssh -c ${logsCommand}`);
    terminal.sendText(`vagrant ssh -c ${logsCommand}`);

    vscode.window.showInformationMessage(`Mostrando logs del contenedor ${selectedContainer}. Presiona Ctrl+C en la terminal para detener.`);

  } catch (error) {
    debugLog(`Error al mostrar logs: ${error instanceof Error ? error.message : String(error)}`);
    vscode.window.showErrorMessage(`Error al mostrar logs: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Función para actualizar un módulo de Odoo en un contenedor
async function updateOdooModule() {
  debugLog('Iniciando función updateOdooModule');

  if (!(await ensureVagrantRunning())) {
    debugLog('La máquina virtual no está corriendo');
    return;
  }

  try {
    // 1. Obtener lista de contenedores Odoo
    debugLog('Obteniendo lista de contenedores Odoo');
    const output = await executeCommand('vagrant ssh -c "docker ps --format \'{{.Names}}|{{.Image}}\'"');
    const containers = output.split('\n')
      .filter(line => line.trim())
      .filter(line => {
        const [_, image] = line.split('|');
        // Filtrar solo contenedores que probablemente sean de Odoo
        return image && (
          image.toLowerCase().includes('odoo') ||
          image.toLowerCase().includes('dashboard') ||
          image.toLowerCase().includes('control')
        );
      })
      .map(line => line.split('|')[0].trim());

    debugLog(`Contenedores Odoo encontrados: ${containers.join(', ')}`);

    if (containers.length === 0) {
      vscode.window.showInformationMessage('No se encontraron contenedores de Odoo');
      return;
    }

    // 2. Seleccionar contenedor
    const selectedContainer = await vscode.window.showQuickPick(containers, {
      placeHolder: 'Selecciona un contenedor de Odoo'
    });

    if (!selectedContainer) {
      debugLog('Usuario canceló la selección de contenedor');
      return;
    }

    debugLog(`Contenedor seleccionado: ${selectedContainer}`);

    // 3. Solicitar nombre del módulo
    const moduleName = await vscode.window.showInputBox({
      prompt: 'Ingresa el nombre del módulo a actualizar',
      placeHolder: 'Ejemplo: base, web, sale, purchase, etc.'
    });

    if (!moduleName) {
      debugLog('Usuario canceló la entrada del nombre del módulo');
      return;
    }

    debugLog(`Módulo ingresado: ${moduleName}`);

    // 4. Confirmar actualización
    const confirmUpdate = await vscode.window.showWarningMessage(
      `¿Estás seguro de que deseas actualizar el módulo "${moduleName}" en el contenedor "${selectedContainer}"?`,
      'Sí, actualizar', 'Cancelar'
    );

    if (confirmUpdate !== 'Sí, actualizar') {
      debugLog('Usuario canceló la actualización');
      return;
    }

    // 5. Ejecutar actualización
    vscode.window.showInformationMessage(`Actualizando módulo ${moduleName}...`);

    // Crear terminal para mostrar el progreso
    const terminal = vscode.window.createTerminal(`Actualizar: ${moduleName}`);
    terminal.show();

    // Usar el nombre del contenedor como nombre de la base de datos
    // Extraer el nombre base del contenedor (sin números o sufijos)
    const dbName = selectedContainer.split('-')[0].replace(/\d+$/, '');

    // Comando para actualizar el módulo
    // Usar comillas dobles alrededor del comando completo
    const updateCommand = `"docker exec ${selectedContainer} odoo -u ${moduleName} -d ${selectedContainer} --stop-after-init"`;

    debugLog(`Ejecutando comando: vagrant ssh -c ${updateCommand}`);
    terminal.sendText(`vagrant ssh -c ${updateCommand}`);

    vscode.window.showInformationMessage(`Actualización de ${moduleName} iniciada. Revisa la terminal para ver el progreso.`);

  } catch (error) {
    debugLog(`Error al actualizar módulo: ${error instanceof Error ? error.message : String(error)}`);
    vscode.window.showErrorMessage(`Error al actualizar módulo: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Función para instalar un módulo de Odoo en un contenedor
async function installOdooModule() {
  debugLog('Iniciando función installOdooModule');

  if (!(await ensureVagrantRunning())) {
    debugLog('La máquina virtual no está corriendo');
    return;
  }

  try {
    // 1. Obtener lista de contenedores Odoo
    debugLog('Obteniendo lista de contenedores Odoo');
    const output = await executeCommand('vagrant ssh -c "docker ps --format \'{{.Names}}|{{.Image}}\'"');
    const containers = output.split('\n')
      .filter(line => line.trim())
      .filter(line => {
        const [_, image] = line.split('|');
        // Filtrar solo contenedores que probablemente sean de Odoo
        return image && (
          image.toLowerCase().includes('odoo') ||
          image.toLowerCase().includes('dashboard') ||
          image.toLowerCase().includes('control')
        );
      })
      .map(line => line.split('|')[0].trim());

    debugLog(`Contenedores Odoo encontrados: ${containers.join(', ')}`);

    if (containers.length === 0) {
      vscode.window.showInformationMessage('No se encontraron contenedores de Odoo');
      return;
    }

    // 2. Seleccionar contenedor
    const selectedContainer = await vscode.window.showQuickPick(containers, {
      placeHolder: 'Selecciona un contenedor de Odoo'
    });

    if (!selectedContainer) {
      debugLog('Usuario canceló la selección de contenedor');
      return;
    }

    debugLog(`Contenedor seleccionado: ${selectedContainer}`);

    // 3. Solicitar nombre del módulo
    const moduleName = await vscode.window.showInputBox({
      prompt: 'Ingresa el nombre del módulo a instalar',
      placeHolder: 'Ejemplo: base, web, sale, purchase, etc.'
    });

    if (!moduleName) {
      debugLog('Usuario canceló la entrada del nombre del módulo');
      return;
    }

    debugLog(`Módulo ingresado: ${moduleName}`);

    // 4. Confirmar instalación
    const confirmInstall = await vscode.window.showWarningMessage(
      `¿Estás seguro de que deseas instalar el módulo "${moduleName}" en el contenedor "${selectedContainer}"?`,
      'Sí, instalar', 'Cancelar'
    );

    if (confirmInstall !== 'Sí, instalar') {
      debugLog('Usuario canceló la instalación');
      return;
    }

    // 5. Ejecutar instalación
    vscode.window.showInformationMessage(`Instalando módulo ${moduleName}...`);

    // Crear terminal para mostrar el progreso
    const terminal = vscode.window.createTerminal(`Instalar: ${moduleName}`);
    terminal.show();

    // Usar el nombre del contenedor como nombre de la base de datos
    // Extraer el nombre base del contenedor (sin números o sufijos)
    const dbName = selectedContainer.split('-')[0].replace(/\d+$/, '');

    // Comando para instalar el módulo
    // Usar comillas dobles alrededor del comando completo
    const installCommand = `"docker exec ${selectedContainer} odoo -i ${moduleName} -d ${selectedContainer} --stop-after-init"`;

    debugLog(`Ejecutando comando: vagrant ssh -c ${installCommand}`);
    terminal.sendText(`vagrant ssh -c ${installCommand}`);

    vscode.window.showInformationMessage(`Instalación de ${moduleName} iniciada. Revisa la terminal para ver el progreso.`);

  } catch (error) {
    debugLog(`Error al instalar módulo: ${error instanceof Error ? error.message : String(error)}`);
    vscode.window.showErrorMessage(`Error al instalar módulo: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Función para verificar el estado de Vagrant de manera más robusta
async function checkVagrantStatus(): Promise<boolean> {
  try {
    debugLog('Iniciando verificación de estado...');
    const process = await executeCommand('vagrant status');
    debugLog(`Salida de vagrant status: ${process}`);

    const lines = process.split('\n');
    const statusLine = lines.find(line => line.trim().startsWith('default'));

    if (statusLine) {
      debugLog(`Línea de estado encontrada: "${statusLine}"`);
      const isRunning = statusLine.toLowerCase().includes('running');
      debugLog(`Estado running encontrado: ${isRunning}`);
      return isRunning;
    }

    debugLog('No se encontró línea de estado');
    return false;

  } catch (error) {
    debugLog(`Error en checkVagrantStatus: ${error}`);
    return false;
  }
}

// Función mejorada para asegurar que Vagrant está corriendo
async function ensureVagrantRunning(): Promise<boolean> {
  const isRunning = await checkVagrantStatus();

  if (!isRunning) {
    const action = await vscode.window.showErrorMessage(
      '❌ La máquina virtual no está corriendo. ¿Deseas iniciarla?',
      'Sí', 'No'
    );

    if (action === 'Sí') {
      // Iniciar la máquina virtual
      executeVagrantCommand('up', '🚀 Iniciando máquina virtual...');

      // Esperar un tiempo razonable y verificar de nuevo
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Verificar si se inició correctamente
      const status = await checkVagrantStatus();
      if (!status) {
        vscode.window.showErrorMessage('❌ No se pudo iniciar la máquina virtual.');
      }
      return status;
    }
    return false;
  }
  return true;
}
