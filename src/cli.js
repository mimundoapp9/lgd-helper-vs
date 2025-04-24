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

// function showMenu() {
//     console.log('\n=== Gestor de Carpetas Prioritarias ===');
//     console.log('1. Ver carpetas prioritarias');
//     console.log('2. Seleccionar nueva carpeta prioritaria');
//     console.log('3. Salir');

//     rl.question('\nSeleccione una opción: ', (answer) => {
//         switch(answer) {
//             case '1':
//                 const priorities = folderManager.getPriorityFolders();
//                 console.log('\nCarpetas prioritarias:');
//                 priorities.forEach((folder, index) => {
//                     console.log(`${index + 1}. ${folder}`);
//                 });
//                 showMenu();
//                 break;

//             case '2':
//                 const folders = listAvailableFolders();
//                 rl.question('\nSeleccione el número de la carpeta: ', (folderIndex) => {
//                     const selected = folders[parseInt(folderIndex) - 1];
//                     if (selected) {
//                         folderManager.setPriorityFolder(selected);
//                         console.log(`Carpeta "${selected}" establecida como prioritaria`);
//                     } else {
//                         console.log('Selección inválida');
//                     }
//                     showMenu();
//                 });
//                 break;

//             case '3':
//                 rl.close();
//                 break;

//             default:
//                 console.log('Opción inválida');
//                 showMenu();
//         }
//     });
// }

showMenu();
