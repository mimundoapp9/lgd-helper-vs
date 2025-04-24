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

// Primero, definimos la clase para el proveedor de la vista de árbol de contenedores
class DockerContainersProvider implements vscode.TreeDataProvider<ContainerItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ContainerItem | undefined | null | void> = new vscode.EventEmitter<ContainerItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ContainerItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor() {
    // Refrescar contenedores cada 30 segundos
    setInterval(() => {
      this.refresh();
    }, 30000);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ContainerItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ContainerItem): Promise<ContainerItem[]> {
    if (element) {
      return []; // No hay hijos para los elementos individuales
    }

    try {
      // Verificar si la VM está corriendo
      const isRunning = await checkVagrantStatus();
      if (!isRunning) {
        return [new ContainerItem('La máquina virtual no está corriendo', 'vm-stopped', vscode.TreeItemCollapsibleState.None)];
      }

      // Obtener lista de contenedores
      const output = await executeCommand('vagrant ssh -c "docker ps --format \'{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}\'"');
      const containers = output.split('\n').filter(line => line.trim());

      if (containers.length === 0) {
        return [new ContainerItem('No hay contenedores en ejecución', 'no-containers', vscode.TreeItemCollapsibleState.None)];
      }

      return containers.map(container => {
        const [name, image, status, ports] = container.split('|');
        
        // Extraer puertos mapeados
        const portMappings: {external: string, internal: string}[] = [];
        const portRegex = /0\.0\.0\.0:(\d+)->(\d+)\/tcp/g;
        let match;
        
        while ((match = portRegex.exec(ports)) !== null) {
          portMappings.push({
            external: match[1],
            internal: match[2]
          });
        }
        
        // Crear descripción con puertos
        let description = status;
        if (portMappings.length > 0) {
          const portInfo = portMappings.map(p => `${p.internal}→${p.external}`).join(', ');
          description += ` | Puertos: ${portInfo}`;
        }
        
        return new ContainerItem(
          name.trim(),
          'container',
          vscode.TreeItemCollapsibleState.None,
          {
            title: "Acciones",
            command: "lgd-helper.showContainerActions",
            arguments: [name.trim()]
          },
          description,
          image
        );
      });
    } catch (error) {
      debugLog(`Error al obtener contenedores: ${error}`);
      return [new ContainerItem(`Error: ${error}`, 'error', vscode.TreeItemCollapsibleState.None)];
    }
  }
}

// Clase para representar un elemento de contenedor en el árbol
class ContainerItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly contextValue: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly description?: string,
    public readonly tooltip?: string
  ) {
    super(label, collapsibleState);
    this.tooltip = tooltip || label;
    this.description = description;
    this.contextValue = contextValue;
    
    // Asignar icono según el tipo
    if (contextValue === 'container') {
      this.iconPath = new vscode.ThemeIcon('server');
    } else if (contextValue === 'vm-stopped') {
      this.iconPath = new vscode.ThemeIcon('debug-disconnect');
    } else if (contextValue === 'error') {
      this.iconPath = new vscode.ThemeIcon('error');
    } else if (contextValue === 'no-containers') {
      this.iconPath = new vscode.ThemeIcon('info');
    }
  }
}

// Función para mostrar acciones disponibles para un contenedor
async function showContainerActions(containerName: string) {
  const actions = [
    'Ver logs',
    'Reiniciar contenedor',
    'Abrir en navegador',
    'Copiar nombre'
  ];

  const selectedAction = await vscode.window.showQuickPick(actions, {
    placeHolder: `Selecciona una acción para ${containerName}`
  });

  if (!selectedAction) {
    return; // Usuario canceló
  }

  switch (selectedAction) {
    case 'Ver logs':
      showContainerLogsById(containerName);
      break;
    case 'Reiniciar contenedor':
      restartContainerById(containerName);
      break;
    case 'Abrir en navegador':
      openContainerInBrowser(containerName);
      break;
    case 'Copiar nombre':
      vscode.env.clipboard.writeText(containerName);
      vscode.window.showInformationMessage(`Nombre del contenedor copiado: ${containerName}`);
      break;
  }
}

// Función para ver logs de un contenedor específico
async function showContainerLogsById(containerName: string) {
  if (!(await ensureVagrantRunning())) {
    return;
  }

  try {
    // Opciones para los logs
    const logOptions = [
      'Ver últimos 100 logs',
      'Ver últimos 300 logs',
      'Ver logs en tiempo real (seguimiento)',
      'Ver logs con timestamps'
    ];

    const selectedOption = await vscode.window.showQuickPick(logOptions, {
      placeHolder: `Opciones de logs para ${containerName}`
    });

    if (!selectedOption) {
      return; // Usuario canceló
    }

    // Crear terminal para mostrar logs
    const terminal = vscode.window.createTerminal(`Logs: ${containerName}`);
    terminal.show();

    // Ejecutar comando según la opción seleccionada
    let command = '';
    switch (selectedOption) {
      case 'Ver últimos 100 logs':
        command = `docker logs ${containerName} --tail 100`;
        break;
      case 'Ver últimos 300 logs':
        command = `docker logs ${containerName} --tail 300`;
        break;
      case 'Ver logs en tiempo real (seguimiento)':
        command = `docker logs -f ${containerName} --tail 50`;
        break;
      case 'Ver logs con timestamps':
        command = `docker logs ${containerName} --tail 100 -t`;
        break;
    }

    terminal.sendText(`vagrant ssh -c "${command}"`);
  } catch (error) {
    debugLog(`Error al mostrar logs: ${error}`);
    vscode.window.showErrorMessage(`Error al mostrar logs: ${error}`);
  }
}

// Función para reiniciar un contenedor específico
async function restartContainerById(containerName: string) {
  if (!(await ensureVagrantRunning())) {
    return;
  }

  try {
    // Confirmar reinicio
    const confirmRestart = await vscode.window.showWarningMessage(
      `¿Estás seguro de que deseas reiniciar el contenedor "${containerName}"?`,
      'Sí, reiniciar', 'Cancelar'
    );

    if (confirmRestart !== 'Sí, reiniciar') {
      return;
    }

    // Mostrar mensaje de información
    vscode.window.showInformationMessage(`Reiniciando contenedor ${containerName}...`);
    
    // Ejecutar comando de reinicio
    await executeCommand(`vagrant ssh -c "docker restart ${containerName}"`);
    
    // Mostrar mensaje de éxito
    vscode.window.showInformationMessage(`✅ Contenedor ${containerName} reiniciado correctamente`);
    
    // Refrescar la vista de contenedores
    dockerContainersProvider.refresh();
  } catch (error) {
    debugLog(`Error al reiniciar contenedor: ${error}`);
    vscode.window.showErrorMessage(`Error al reiniciar contenedor: ${error}`);
  }
}

// Función para abrir un contenedor en el navegador
async function openContainerInBrowser(containerName: string) {
  if (!(await ensureVagrantRunning())) {
    return;
  }

  try {
    // Obtener puertos del contenedor
    const output = await executeCommand(`vagrant ssh -c "docker ps --format '{{.Ports}}' --filter name=${containerName}"`);
    const portRegex = /0\.0\.0\.0:(\d+)->(\d+)\/tcp/g;
    const ports: {external: string, internal: string}[] = [];
    
    let match;
    while ((match = portRegex.exec(output)) !== null) {
      ports.push({
        external: match[1],
        internal: match[2]
      });
    }

    if (ports.length === 0) {
      vscode.window.showInformationMessage(`El contenedor ${containerName} no tiene puertos expuestos.`);
      return;
    }

    if (ports.length === 1) {
      // Si solo hay un puerto, abrirlo directamente
      const url = `http://192.168.56.10:${ports[0].external}`;
      vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }

    // Si hay múltiples puertos, mostrar opciones
    const portOptions = ports.map(p => `Puerto ${p.internal} (externo: ${p.external})`);
    
    const selectedPort = await vscode.window.showQuickPick(portOptions, {
      placeHolder: 'Selecciona un puerto para abrir en el navegador'
    });

    if (!selectedPort) {
      return; // Usuario canceló
    }

    // Extraer el puerto externo seleccionado
    const selectedIndex = portOptions.indexOf(selectedPort);
    const url = `http://192.168.56.10:${ports[selectedIndex].external}`;
    
    vscode.env.openExternal(vscode.Uri.parse(url));
  } catch (error) {
    debugLog(`Error al abrir en navegador: ${error}`);
    vscode.window.showErrorMessage(`Error al abrir en navegador: ${error}`);
  }
}

// Variable global para el proveedor de contenedores
let dockerContainersProvider: DockerContainersProvider;

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

    // Validar la estructura del workspace
    validateWorkspaceStructure();

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
    })
    ];

    context.subscriptions.push(...commands);

    // Registrar el PriorityFolderProvider
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (workspaceRoot) {
        const priorityFolderProvider = new PriorityFolderProvider(workspaceRoot);
        vscode.window.registerTreeDataProvider('priorityFolders', priorityFolderProvider);
    }

    // Registrar el proveedor de contenedores
    dockerContainersProvider = new DockerContainersProvider();
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('dockerContainers', dockerContainersProvider)
    );

    // Registrar comandos relacionados con contenedores
    context.subscriptions.push(
      vscode.commands.registerCommand('lgd-helper.refreshContainers', () => dockerContainersProvider.refresh()),
      vscode.commands.registerCommand('lgd-helper.showContainerActions', showContainerActions)
    );
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
        case 'showLogs':
          showContainerLogs();
          break;
        case 'restartContainer':
          restartContainer();
          break;
        case 'listPorts':
          listContainerPorts();
          break;
        case 'showDatabases':
          showDatabases();
          break;
        case 'checkStatus':
          this._checkAndUpdateStatus();
          break;
        case 'showDebugLogs':
          showDebugLogs();
          break;
        case 'updateOdooModule':
          updateOdooModule();
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
  debugLog('Iniciando función showContainerLogs');
  
  if (!(await ensureVagrantRunning())) {
    debugLog('La máquina virtual no está corriendo');
    return;
  }

  try {
    debugLog('Obteniendo lista de contenedores');
    // Obtener lista de contenedores
    const output = await executeCommand('vagrant ssh -c "docker ps --format \'{{.Names}}\'"');
    const containers = output.split('\n').filter(line => line.trim());
    debugLog(`Contenedores encontrados: ${containers.join(', ')}`);

    if (containers.length === 0) {
      vscode.window.showInformationMessage('No hay contenedores en ejecución');
      return;
    }

    // Mostrar quickpick para seleccionar contenedor
    debugLog('Mostrando selector de contenedores');
    const selectedContainer = await vscode.window.showQuickPick(containers, {
      placeHolder: 'Selecciona un contenedor para ver sus logs'
    });

    if (!selectedContainer) {
      debugLog('Usuario canceló la selección de contenedor');
      return; // Usuario canceló
    }
    
    debugLog(`Contenedor seleccionado: ${selectedContainer}`);

    // Opciones para los logs
    const logOptions = [
      'Ver últimos 100 logs',
      'Ver últimos 300 logs',
      'Ver logs en tiempo real (seguimiento)',
      'Ver logs con timestamps'
    ];

    debugLog('Mostrando opciones de logs');
    const selectedOption = await vscode.window.showQuickPick(logOptions, {
      placeHolder: `Opciones de logs para ${selectedContainer}`
    });

    if (!selectedOption) {
      debugLog('Usuario canceló la selección de opciones');
      return; // Usuario canceló
    }
    
    debugLog(`Opción seleccionada: ${selectedOption}`);

    // Crear terminal para mostrar logs
    debugLog('Creando terminal para logs');
    const terminal = vscode.window.createTerminal(`Logs: ${selectedContainer}`);
    terminal.show();

    // Ejecutar comando según la opción seleccionada
    let command = '';
    switch (selectedOption) {
      case 'Ver últimos 100 logs':
        command = `docker logs ${selectedContainer} --tail 100`;
        break;
      case 'Ver últimos 300 logs':
        command = `docker logs ${selectedContainer} --tail 300`;
        break;
      case 'Ver logs en tiempo real (seguimiento)':
        command = `docker logs -f ${selectedContainer} --tail 50`;
        break;
      case 'Ver logs con timestamps':
        command = `docker logs ${selectedContainer} --tail 100 -t`;
        break;
    }

    debugLog(`Ejecutando comando: vagrant ssh -c "${command}"`);
    terminal.sendText(`vagrant ssh -c "${command}"`);

  } catch (error) {
    debugLog(`Error al mostrar logs: ${error}`);
    vscode.window.showErrorMessage(`Error al mostrar logs: ${error}`);
  }
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
        // Obtener información detallada de los puertos
        const output = await executeCommand('vagrant ssh -c "docker ps --format \'{{.Names}}|{{.Image}}|{{.Ports}}\'"');
        const containers = output.split('\n').filter(line => line.trim());
        
        const containerPortMappings = new Map<string, {external: string, internal: string}[]>();
        
        containers.forEach(line => {
            const [name, image, ports] = line.split('|');
            if (!ports) return;
            
            // Buscar todos los mapeos de puertos con formato: 0.0.0.0:EXTERNO->INTERNO/tcp
            const portRegex = /0\.0\.0\.0:(\d+)->(\d+)\/tcp/g;
            let match;
            const mappings: {external: string, internal: string}[] = [];
            
            while ((match = portRegex.exec(ports)) !== null) {
                mappings.push({
                    external: match[1],
                    internal: match[2]
                });
            }
            
            if (mappings.length > 0) {
                containerPortMappings.set(name.trim(), mappings);
            }
        });

        // Crear un panel de información en lugar de una terminal
        const panel = vscode.window.createWebviewPanel(
            'lgdPorts',
            'LGD Puertos',
            vscode.ViewColumn.One,
            {
                enableScripts: true
            }
        );

        // Construir el HTML para el panel
        let portListHtml = '';
        containerPortMappings.forEach((mappings, containerName) => {
            mappings.forEach(mapping => {
                const url = `http://192.168.56.10:${mapping.external}`;
                portListHtml += `
                <div class="port-item">
                    <div class="container-name">${containerName} <span class="port-badge">${mapping.internal}</span></div>
                    <a href="${url}" class="port-link">${url}</a>
                </div>`;
            });
        });

        panel.webview.html = `
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>LGD Puertos</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 1rem;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                }
                h1 {
                    font-size: 1.5rem;
                    margin-bottom: 1rem;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 0.5rem;
                }
                .port-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.8rem;
                }
                .port-item {
                    padding: 0.8rem;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    background-color: var(--vscode-editor-background);
                }
                .container-name {
                    font-weight: bold;
                    margin-bottom: 0.3rem;
                }
                .port-badge {
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    padding: 0.1rem 0.4rem;
                    border-radius: 10px;
                    font-size: 0.8rem;
                    margin-left: 0.5rem;
                }
                .port-link {
                    color: var(--vscode-textLink-foreground);
                    text-decoration: none;
                }
                .port-link:hover {
                    text-decoration: underline;
                }
                .refresh-button {
                    margin-top: 1rem;
                    padding: 0.5rem 1rem;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 2px;
                    cursor: pointer;
                }
                .refresh-button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
            </style>
        </head>
        <body>
            <h1>🔗 Enlaces disponibles</h1>
            <div class="port-list">
                ${portListHtml}
            </div>
            <button class="refresh-button" onclick="refreshPorts()">🔄 Actualizar puertos</button>
            
            <script>
                const vscode = acquireVsCodeApi();
                
                function refreshPorts() {
                    vscode.postMessage({ command: 'refresh' });
                }
            </script>
        </body>
        </html>`;

        // Manejar mensajes del webview
        panel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'refresh') {
                    listContainerPorts();
                }
            }
        );

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

async function restartContainer() {
  debugLog('Iniciando función restartContainer');
  
  if (!(await ensureVagrantRunning())) {
    debugLog('La máquina virtual no está corriendo');
    return;
  }

  try {
    debugLog('Obteniendo lista de contenedores');
    // Obtener lista de contenedores
    const output = await executeCommand('vagrant ssh -c "docker ps --format \'{{.Names}}\'"');
    const containers = output.split('\n').filter(line => line.trim());
    debugLog(`Contenedores encontrados: ${containers.join(', ')}`);

    if (containers.length === 0) {
      vscode.window.showInformationMessage('No hay contenedores en ejecución');
      return;
    }

    // Mostrar quickpick para seleccionar contenedor
    debugLog('Mostrando selector de contenedores');
    const selectedContainer = await vscode.window.showQuickPick(containers, {
      placeHolder: 'Selecciona un contenedor para reiniciar'
    });

    if (!selectedContainer) {
      debugLog('Usuario canceló la selección de contenedor');
      return; // Usuario canceló
    }
    
    debugLog(`Contenedor seleccionado: ${selectedContainer}`);

    // Confirmar reinicio
    const confirmRestart = await vscode.window.showWarningMessage(
      `¿Estás seguro de que deseas reiniciar el contenedor "${selectedContainer}"?`,
      'Sí, reiniciar', 'Cancelar'
    );

    if (confirmRestart !== 'Sí, reiniciar') {
      debugLog('Usuario canceló el reinicio');
      return;
    }

    // Mostrar mensaje de información
    vscode.window.showInformationMessage(`Reiniciando contenedor ${selectedContainer}...`);
    
    // Ejecutar comando de reinicio
    debugLog(`Ejecutando comando de reinicio para ${selectedContainer}`);
    await executeCommand(`vagrant ssh -c "docker restart ${selectedContainer}"`);
    
    // Mostrar mensaje de éxito
    vscode.window.showInformationMessage(`✅ Contenedor ${selectedContainer} reiniciado correctamente`);

  } catch (error) {
    debugLog(`Error al reiniciar contenedor: ${error}`);
    vscode.window.showErrorMessage(`Error al reiniciar contenedor: ${error}`);
  }
}

// Función simplificada para actualizar un módulo de Odoo en un contenedor
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

    // 3. Solicitar nombre del módulo directamente
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
    
    // Comando para actualizar el módulo
    const updateCommand = `docker exec ${selectedContainer} odoo -u ${moduleName} -d odoo --stop-after-init`;
    
    debugLog(`Ejecutando comando: ${updateCommand}`);
    terminal.sendText(`vagrant ssh -c "${updateCommand}"`);
    
    vscode.window.showInformationMessage(`Actualización de ${moduleName} iniciada. Revisa la terminal para ver el progreso.`);

  } catch (error) {
    debugLog(`Error al actualizar módulo: ${error}`);
    vscode.window.showErrorMessage(`Error al actualizar módulo: ${error}`);
  }
}
