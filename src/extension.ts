import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { PriorityFolderProvider } from './priorityFolderProvider';

// Interfaz para los contenedores
interface Container {
  name: string;
  image: string;
  ports: string[];
}

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
    // Crear el canal de output siempre
    outputChannel = vscode.window.createOutputChannel('LGD Helper Debug');

    // Detectar modo debug
    isDebugging = process.env.VSCODE_DEBUG_MODE === "true";

    if (isDebugging) {
        outputChannel.show(true);
        outputChannel.appendLine('🔍 Extensión iniciada en modo debug');
        outputChannel.appendLine(`Session ID: ${vscode.env.sessionId}`);
        outputChannel.appendLine(`Workspace: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'none'}`);
    }

    // Registrar el WebviewViewProvider
    const provider = new LGDViewProvider(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('lgdView', provider)
    );

    // Registrar todos los comandos
    let commands = [
      vscode.commands.registerCommand('lgd-helper.startVM', () => {
        executeVagrantCommand('up', '🚀 Iniciando máquina virtual...');
      }),
      vscode.commands.registerCommand('lgd-helper.stopVM', () => {
        executeVagrantCommand('halt', '🛑 Deteniendo máquina virtual...');
      }),
      vscode.commands.registerCommand('lgd-helper.showLogs', () => {
        showContainerLogs();
      }),
      vscode.commands.registerCommand('lgd-helper.listPorts', () => {
        listContainerPorts();
      }),
      vscode.commands.registerCommand('lgd-helper.showDatabases', () => {
        showDatabases();
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
      vscode.commands.registerCommand('lgd-helper.selectPriorityFolder', async () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No hay un workspace abierto');
            return;
        }

        const devPath = path.join(workspaceRoot, 'dev');

        try {
            function findAllSubfolders(dir: string): string[] {
                const results: string[] = [];
                const items = fs.readdirSync(dir);

                for (const item of items) {
                    const fullPath = path.join(dir, item);
                    if (fs.statSync(fullPath).isDirectory()) {
                        const relativePath = path.relative(devPath, fullPath);
                        // Solo incluir subcarpetas, no las carpetas de primer nivel
                        if (relativePath.includes(path.sep)) {
                            results.push(relativePath);
                        }
                        results.push(...findAllSubfolders(fullPath));
                    }
                }

                return results;
            }

            const folders = findAllSubfolders(devPath);

            const selected = await vscode.window.showQuickPick(folders, {
                placeHolder: 'Selecciona una carpeta para hacerla prioritaria'
            });

            if (selected) {
                const configPath = path.join(workspaceRoot, 'config.json');
                let config = { priorityFolders: [], devPath: "./dev", lastSelectedFolder: null };

                if (fs.existsSync(configPath)) {
                    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                }

                if (!config.priorityFolders.includes(selected)) {
                    config.priorityFolders.push(selected);
                }
                config.lastSelectedFolder = selected;

                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                vscode.window.showInformationMessage(`Carpeta "${selected}" establecida como prioritaria`);

                priorityFolderProvider.refresh();
            }
        } catch (error) {
            vscode.window.showErrorMessage('Error al acceder a la carpeta dev');
        }
    }),
    vscode.commands.registerCommand('lgd-helper.removePriorityFolder', async (folder: PriorityFolder) => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceRoot) {
            return;
        }

        const configPath = path.join(workspaceRoot, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            config.priorityFolders = config.priorityFolders.filter((f: string) => f !== folder.relativePath);
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

            // Refrescar la vista
            priorityFolderProvider.refresh();

            vscode.window.showInformationMessage(`Carpeta "${folder.label}" removida de prioritarias`);
        }
    }),
    vscode.commands.registerCommand('lgd-helper.createWorkspace', async () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No hay un workspace abierto');
            return;
        }

        const devPath = path.join(workspaceRoot, 'dev');
        if (!fs.existsSync(devPath)) {
            vscode.window.showErrorMessage('No se encuentra la carpeta dev');
            return;
        }

        try {
            const workspacePath = await createWorkspace(devPath);

            // Abrir el workspace
            const uri = vscode.Uri.file(workspacePath);
            await vscode.commands.executeCommand('vscode.openFolder', uri);

            vscode.window.showInformationMessage('Workspace creado exitosamente');
        } catch (error) {
            vscode.window.showErrorMessage('Error al crear el workspace');
            console.error(error);
        }
    })
    ];

    context.subscriptions.push(...commands);

    // Registrar el PriorityFolderProvider
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (workspaceRoot) {
        const priorityFolderProvider = new PriorityFolderProvider(workspaceRoot);
        vscode.window.registerTreeDataProvider('priorityFolders', priorityFolderProvider);
    }

    // Cargar puertos al inicio
    loadContainerPorts();
}

function executeVagrantCommand(command: string, message: string) {
  debugLog(`Ejecutando vagrant ${command} en ${VAGRANT_DIR}`);

  const terminal = vscode.window.createTerminal({
    name: "LGD – VM",
    cwd: VAGRANT_DIR // Especificar el directorio de trabajo
  });

  terminal.show();
  terminal.sendText(`vagrant ${command}`);
  vscode.window.showInformationMessage(message);
}

class LGDViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

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

    webviewView.webview.html = this._getHtmlContent();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'startVM':
          executeVagrantCommand('up', '🚀 Iniciando máquina virtual...');
          break;
        case 'stopVM':
          executeVagrantCommand('halt', '🛑 Deteniendo máquina virtual...');
          break;
        case 'showLogs':
          showContainerLogs();
          break;
        case 'listPorts':
          listContainerPorts();
          break;
        case 'showDatabases':
          showDatabases();
          break;
        case 'checkStatus':
          vscode.commands.executeCommand('lgd-helper.checkStatus');
          break;
        case 'showDebugLogs':
          showDebugLogs();
          break;
      }
    });
  }

  private _getHtmlContent(): string {
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
          </style>
        </head>
        <body>
          <div class="section">
            <h3>🖥️ Máquina Virtual</h3>
            <button onclick="startVM()">✨ Iniciar Máquina Virtual</button>
            <button onclick="stopVM()" class="stop-button">🛑 Detener Máquina Virtual</button>
            <button onclick="checkStatus()">🔍 Verificar Estado</button>
          </div>

          <div class="section">
            <h3>🐳 Contenedores</h3>
            <button onclick="showLogs()">📋 Ver logs del contenedor</button>
            <button onclick="listPorts()">🔗 Listar puertos</button>
          </div>

          <div class="section">
            <h3>🗄️ Base de Datos</h3>
            <button onclick="showDatabases()">💾 Gestionar bases de datos</button>
          </div>

          <script>
            const vscode = acquireVsCodeApi();

            function startVM() {
              vscode.postMessage({ command: 'startVM' });
            }

            function stopVM() {
              vscode.postMessage({ command: 'stopVM' });
            }

            function showLogs() {
              vscode.postMessage({ command: 'showLogs' });
            }

            function listPorts() {
              vscode.postMessage({ command: 'listPorts' });
            }

            function showDatabases() {
              vscode.postMessage({ command: 'showDatabases' });
            }

            function checkStatus() {
              vscode.postMessage({ command: 'checkStatus' });
            }

            function showDebugLogs() {
              vscode.postMessage({ command: 'showDebugLogs' });
            }
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

// Modificar las funciones existentes para usar la verificación
async function showContainerLogs() {
  if (!(await ensureVagrantRunning())) {
    return;
  }
  const terminal = vscode.window.createTerminal('LGD Logs');
  terminal.show();
  terminal.sendText('vagrant ssh -c "docker logs -f lgdoo --tail 300"');
}

// Función para cargar los puertos
async function loadContainerPorts() {
    try {
        const output = await executeCommand('vagrant ssh -c "docker ps --format \'{{.Names}}|{{.Image}}|{{.Ports}}\'"');
        const containers = output.split('\n').filter(line => line.trim());

        containerPorts.clear();
        containers.forEach(line => {
            const [name, image, ports] = line.split('|');
            const portMatches = ports ? ports.match(/0.0.0.0:(\d+)/g) || [] : [];
            const mappedPorts = portMatches.map(p => p.split(':')[1]);
            containerPorts.set(name.trim(), mappedPorts);
        });
    } catch (error) {
        debugLog(`Error cargando puertos: ${error}`);
    }
}

// Modificar la función listContainerPorts
async function listContainerPorts() {
    if (!(await ensureVagrantRunning())) {
        return;
    }

    try {
        await loadContainerPorts();

        const terminal = vscode.window.createTerminal({
            name: 'LGD Ports',
            cwd: VAGRANT_DIR,
            hideFromUser: true // Ocultar el comando
        });

        // Construir el comando completo
        const command = [
            'clear', // Limpiar terminal primero
            'echo "🔗 Enlaces disponibles:"',
            'echo ""',
            'echo "Seguir vínculo (ctrl + clic)"',
            'echo ""'
        ];

        // Añadir los enlaces con nombre del contenedor
        containerPorts.forEach((ports, containerName) => {
            if (ports.length > 0) {
                ports.forEach(port => {
                    const formattedName = containerName.padEnd(40, ' ');
                    command.push(`echo "${formattedName} ➜ http://192.168.56.10:${port}"`);
                });
            }
        });

        command.push('echo ""');
        command.push('echo "✅ Listado completado."');

        terminal.show();
        terminal.sendText(command.join(' && '), true); // true = no añadir nueva línea

    } catch (error) {
        debugLog(`Error al listar puertos: ${error}`);
        vscode.window.showErrorMessage(`❌ Error al listar puertos: ${error}`);
    }
}

// Añadir función para refrescar puertos periódicamente
function startPortRefreshInterval() {
    setInterval(async () => {
        await loadContainerPorts();
    }, 30000); // Refrescar cada 30 segundos
}

// Mostrar bases de datos
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
        const rootName = path.basename(workspaceRoot);

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
        console.error('Error al crear workspace:', error);
        throw error;
    }
}
