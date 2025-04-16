const fs = require('fs');
const path = require('path');

class FolderManager {
    constructor() {
        this.configPath = path.join(__dirname, '../config.json');
        this.config = this.loadConfig();
    }

    loadConfig() {
        try {
            return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        } catch (error) {
            return {
                priorityFolders: [],
                devPath: "./dev",
                lastSelectedFolder: null
            };
        }
    }

    saveConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    }

    setPriorityFolder(folderPath) {
        const fullPath = path.resolve(this.config.devPath, folderPath);
        if (fs.existsSync(fullPath)) {
            this.config.lastSelectedFolder = folderPath;
            if (!this.config.priorityFolders.includes(folderPath)) {
                this.config.priorityFolders.unshift(folderPath);
            }
            this.saveConfig();
            return true;
        }
        return false;
    }

    getPriorityFolders() {
        return this.config.priorityFolders;
    }

    getLastSelected() {
        return this.config.lastSelectedFolder;
    }
}

module.exports = FolderManager;
