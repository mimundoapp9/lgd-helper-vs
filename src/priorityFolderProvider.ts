import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class PriorityFolderProvider implements vscode.TreeDataProvider<PriorityFolder> {
    private _onDidChangeTreeData: vscode.EventEmitter<PriorityFolder | undefined | null | void> = new vscode.EventEmitter<PriorityFolder | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<PriorityFolder | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private workspaceRoot: string) {
        // Al inicializar, mapear las carpetas de primer nivel
        this.initializeDefaultFolders();
    }

    private initializeDefaultFolders() {
        const devPath = path.join(this.workspaceRoot, 'dev');
        if (!fs.existsSync(devPath)) return;

        const configPath = path.join(this.workspaceRoot, 'config.json');
        let config = { priorityFolders: [], devPath: "./dev", lastSelectedFolder: null };

        // Cargar configuración existente o crear nueva
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }

        // Obtener todas las carpetas de primer nivel en dev
        const topLevelFolders = fs.readdirSync(devPath)
            .filter(item => fs.statSync(path.join(devPath, item)).isDirectory());

        // Agregar carpetas que no estén ya en la lista de prioridades
        topLevelFolders.forEach(folder => {
            if (!config.priorityFolders.includes(folder)) {
                config.priorityFolders.push(folder);
            }
        });

        // Guardar la configuración actualizada
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PriorityFolder): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<PriorityFolder[]> {
        if (!this.workspaceRoot) {
            return Promise.resolve([]);
        }

        const configPath = path.join(this.workspaceRoot, 'config.json');
        if (!fs.existsSync(configPath)) {
            return Promise.resolve([]);
        }

        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const priorityFolders = config.priorityFolders || [];
            const devPath = path.join(this.workspaceRoot, 'dev');

            return Promise.resolve(
                priorityFolders.map(relativePath => {
                    const folderPath = path.join(devPath, relativePath);
                    const folderName = path.basename(relativePath);
                    return new PriorityFolder(
                        folderName,
                        folderPath,
                        relativePath,
                        vscode.TreeItemCollapsibleState.None
                    );
                }).filter(folder => fs.existsSync(folder.folderPath))
            );
        } catch (error) {
            console.error('Error al leer las carpetas:', error);
            return Promise.resolve([]);
        }
    }
}

class PriorityFolder extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly folderPath: string,
        public readonly relativePath: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.tooltip = `${this.relativePath}`;
        this.description = path.dirname(this.relativePath);
        this.iconPath = new vscode.ThemeIcon("folder");
        this.command = {
            command: 'vscode.openFolder',
            title: 'Abrir Carpeta',
            arguments: [vscode.Uri.file(this.folderPath), { forceNewWindow: false }]
        };
    }
}
