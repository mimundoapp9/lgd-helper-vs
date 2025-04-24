const FolderManager = require('./folderManager');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const folderManager = new FolderManager();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function listAvailableFolders() {
    const devPath = path.resolve(folderManager.config.devPath);
    if (!fs.existsSync(devPath)) {
        console.log('La carpeta dev no existe');
        return [];
    }

    const folders = fs.readdirSync(devPath)
        .filter(f => fs.statSync(path.join(devPath, f)).isDirectory());

    console.log('\nCarpetas disponibles:');
    folders.forEach((folder, index) => {
        console.log(`${index + 1}. ${folder}`);
    });

    return folders;
}

showMenu();
