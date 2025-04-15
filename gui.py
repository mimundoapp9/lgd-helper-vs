import tkinter as tk
from tkinter import scrolledtext
import subprocess
import threading
from tkinter import filedialog
import os
import json
import re
import time
import zipfile
import shutil


def create_vscode_config(repo_path, output_box):
    vscode_dir = os.path.join(repo_path, ".vscode")
    tasks_file = os.path.join(vscode_dir, "tasks.json")

    # Obtener el nombre del repositorio del path
    repo_name = os.path.basename(repo_path)

    # Obtener la variable de entorno USERDEV
    user_dev = os.getenv("USERDEV", "controlcdms-gh")  # 'local' como valor por defecto

    # Construir el nombre del contenedor de forma más simple
    container_name = f"{repo_name}-local-{user_dev}"

    try:
        # Crear directorio .vscode si no existe
        if not os.path.exists(vscode_dir):
            os.makedirs(vscode_dir)

        tasks_json = {
            "version": "2.0.0",
            "tasks": [
                {
                    "label": "🚀 Iniciar Contenedor Odoo",
                    "type": "shell",
                    "command": f"vagrant ssh -c 'docker start {container_name} && docker logs -f {container_name}'",
                    "presentation": {
                        "reveal": "always",
                        "panel": "dedicated",
                        "focus": True,
                        "clear": True,
                    },
                    "group": {"kind": "test", "isDefault": True},
                    "problemMatcher": [],
                },
                {
                    "label": "🔁 Reiniciar Contenedor Odoo",
                    "type": "shell",
                    "command": f"vagrant ssh -c 'docker restart {container_name} && docker logs -f {container_name}'",
                    "presentation": {
                        "reveal": "always",
                        "panel": "dedicated",
                        "focus": True,
                        "clear": True,
                    },
                    "group": "test",
                    "problemMatcher": [],
                },
                {
                    "label": "⏹️ Detener Contenedor Odoo",
                    "type": "shell",
                    "command": f"vagrant ssh -c 'docker stop {container_name} && echo \"Contenedor detenido\"'",
                    "presentation": {
                        "reveal": "always",
                        "panel": "dedicated",
                        "focus": True,
                        "clear": True,
                    },
                    "group": "test",
                    "problemMatcher": [],
                },
            ],
        }

        # Crear o sobrescribir el archivo tasks.json
        with open(tasks_file, "w") as f:
            json.dump(tasks_json, f, indent=4)

        output_box.insert(tk.END, "✨ Configuración de VS Code actualizada\n")
        return True

    except Exception as e:
        output_box.insert(
            tk.END, f"❌ Error al crear configuración de VS Code: {str(e)}\n"
        )
        return False


def create_folder_selector():
    # Crear una nueva ventana
    selector = tk.Toplevel(root)
    selector.title("Seleccionar Repositorio")
    selector.geometry("400x300")
    selector.configure(bg="#1e1e1e")

    # Variable para almacenar la selección
    selected_folder = tk.StringVar()

    # Obtener la lista de carpetas en dev
    default_path = os.path.join(os.getcwd(), "dev")
    if not os.path.exists(default_path):
        os.makedirs(default_path)

    folders = [
        d
        for d in os.listdir(default_path)
        if os.path.isdir(os.path.join(default_path, d))
    ]

    # Crear listbox para mostrar las carpetas
    listbox = tk.Listbox(
        selector, bg="#333", fg="#00FF00", font=("Consolas", 12), selectmode=tk.SINGLE
    )
    listbox.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

    # Añadir carpetas al listbox
    for folder in folders:
        listbox.insert(tk.END, folder)

    def on_select():
        if listbox.curselection():
            selected = listbox.get(listbox.curselection())
            repo_path = os.path.join(default_path, selected)
            selected_folder.set(repo_path)
            selector.destroy()

    # Botón de selección
    select_btn = tk.Button(
        selector,
        text="✅ Seleccionar",
        font=("Consolas", 12),
        bg="#333",
        fg="#00FF00",
        command=on_select,
    )
    select_btn.pack(pady=10)

    # Esperar a que se cierre la ventana
    selector.wait_window()
    return selected_folder.get()


def select_repository():
    repo_path = create_folder_selector()

    if repo_path:
        output_box.insert(tk.END, f"📂 Repositorio seleccionado: {repo_path}\n")
        # Crear configuración de VS Code
        if create_vscode_config(repo_path, output_box):
            output_box.insert(tk.END, "✨ Configuración de VS Code creada\n")

        # Abrir Cursor en la ruta seleccionada
        try:
            cursor_path = "/home/algoritmia/bin/cursor-0.45.14x86_64.AppImage"
            subprocess.Popen([cursor_path, repo_path])
            output_box.insert(tk.END, "✨ Cursor abierto en el repositorio\n")
        except Exception as e:
            output_box.insert(tk.END, f"❌ Error al abrir Cursor: {str(e)}\n")
            output_box.insert(
                tk.END,
                "Por favor, asegúrate de que Cursor esté instalado correctamente\n",
            )


def check_vagrant_status():
    try:
        # Intentar obtener el estado de vagrant
        process = subprocess.Popen(
            ["vagrant", "status"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        output = process.communicate()[0]

        # Si encuentra "running" en la salida, la máquina está encendida
        is_running = "running" in output.lower()
        return is_running
    except Exception:
        return False


def update_start_button_state():
    is_running = check_vagrant_status()
    if is_running:
        start_btn.config(text="✨ Entorno LGD Activo", state="disabled", fg="#888888")
        halt_btn.config(state="normal", fg="#00FF00")
        output_box.insert(tk.END, "✅ La máquina virtual está encendida\n")
    else:
        start_btn.config(text="✨ Iniciar entorno LGD", state="normal", fg="#00FF00")
        halt_btn.config(state="disabled", fg="#888888")
        output_box.insert(tk.END, "⚠️ La máquina virtual está apagada\n")


def run_vagrant_up(output_box):
    if check_vagrant_status():
        output_box.insert(tk.END, "⚠️ La máquina virtual ya está encendida\n")
        return

    output_box.delete(1.0, tk.END)
    output_box.insert(tk.END, "🔧 Ejecutando 'vagrant up'...\n\n")

    def task():
        process = subprocess.Popen(
            ["vagrant", "up"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        for line in process.stdout:
            output_box.insert(tk.END, line)
            output_box.see(tk.END)
        output_box.insert(tk.END, "\n✅ Entorno iniciado.\n")
        # Actualizar estado del botón después de iniciar
        root.after(0, update_start_button_state)

    threading.Thread(target=task).start()


def run_vagrant_halt(output_box):
    output_box.delete(1.0, tk.END)
    output_box.insert(tk.END, "🛑 Deteniendo la máquina virtual...\n\n")

    def task():
        process = subprocess.Popen(
            ["vagrant", "halt"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        for line in process.stdout:
            output_box.insert(tk.END, line)
            output_box.see(tk.END)
        output_box.insert(tk.END, "\n✅ Máquina virtual detenida.\n")
        # Actualizar estado del botón después de detener
        root.after(0, update_start_button_state)

    threading.Thread(target=task).start()


def show_container_logs(output_box):
    output_box.delete(1.0, tk.END)
    output_box.insert(tk.END, "📋 Obteniendo logs del contenedor...\n\n")

    def task():
        process = subprocess.Popen(
            ["vagrant", "ssh", "-c", "docker logs -f lgdoo --tail 300"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        for line in process.stdout:
            output_box.insert(tk.END, line)
            output_box.see(tk.END)

    threading.Thread(target=task).start()


def list_container_ports(output_box):
    output_box.delete(1.0, tk.END)
    output_box.insert(tk.END, "🔍 Contenedores en ejecución:\n\n")

    # Configurar el tag para los hipervínculos
    output_box.tag_config("link", foreground="cyan", underline=1)

    def open_url(url):
        import webbrowser

        webbrowser.open(url)

    def tag_click(event):
        # Obtener el índice del click
        index = output_box.index(f"@{event.x},{event.y}")
        # Obtener los tags en esa posición
        tags = output_box.tag_names(index)
        for tag in tags:
            if tag.startswith("link_"):
                url = tag.split("link_")[1]
                open_url(url)
                break

    # Bindear el evento de click
    output_box.tag_bind("link", "<Button-1>", tag_click)
    output_box.config(cursor="arrow")

    def task():
        vm_ip = "192.168.56.10"

        process = subprocess.Popen(
            [
                "vagrant",
                "ssh",
                "-c",
                "docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}'",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        for line in process.stdout:
            if line.strip():
                parts = line.strip().split("|")
                container_name = parts[0]
                image_name = parts[1]
                ports = parts[2] if len(parts) > 2 else ""

                output_box.insert(tk.END, f"📦 Contenedor: {container_name}\n")
                output_box.insert(tk.END, f"   🖼️ Imagen: {image_name}\n")

                # Buscar puertos mapeados
                matches = re.finditer(r"0.0.0.0:(\d+)", ports)
                ports_found = False

                for match in matches:
                    ports_found = True
                    port = match.group(1)
                    url = f"http://{vm_ip}:{port}"

                    # Insertar el enlace con formato especial
                    output_box.insert(tk.END, "   🔗 ")
                    start_index = output_box.index("end-1c")
                    output_box.insert(tk.END, f"{url}\n")
                    end_index = output_box.index("end-1c")

                    # Aplicar tags para el hipervínculo
                    output_box.tag_add(
                        f"link_http://{vm_ip}:{port}", start_index, end_index
                    )
                    output_box.tag_add("link", start_index, end_index)

                if not ports_found:
                    output_box.insert(tk.END, "   ⚠️ Sin puertos mapeados\n")

                output_box.insert(tk.END, "\n")

        output_box.insert(tk.END, "\n✅ Listado completado.\n")
        output_box.see(tk.END)

    threading.Thread(target=task).start()


def show_databases(output_box):
    output_box.delete(1.0, tk.END)
    output_box.insert(tk.END, "📊 Listando bases de datos...\n\n")

    def task():
        try:
            # Comando modificado para listar las bases de datos
            command = "vagrant ssh -c 'docker exec ldb psql -U odoo -l'"

            process = subprocess.Popen(
                command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )

            databases = []
            # Saltar la cabecera
            next(process.stdout)
            next(process.stdout)

            for line in process.stdout:
                if line.strip() and not line.startswith("-"):
                    db_name = line.split("|")[0].strip()
                    if db_name and not db_name.startswith("template"):
                        databases.append(db_name)
                        output_box.insert(tk.END, f"💾 {db_name}\n")
                        output_box.see(tk.END)

            if not databases:
                output_box.insert(tk.END, "⚠️ No se encontraron bases de datos\n")

            output_box.insert(tk.END, "\n✅ Listado completado.\n")

            # Crear selector de base de datos
            selector = tk.Toplevel(root)
            selector.title("Seleccionar Base de Datos")
            selector.geometry("400x300")
            selector.configure(bg="#1e1e1e")

            listbox = tk.Listbox(
                selector,
                bg="#333",
                fg="#00FF00",
                font=("Consolas", 12),
                selectmode=tk.SINGLE,
            )
            listbox.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

            for db in databases:
                listbox.insert(tk.END, db)

            def on_delete():
                if listbox.curselection():
                    selected_db = listbox.get(listbox.curselection())
                    selector.destroy()
                    delete_selected_database(selected_db, output_box)

            delete_btn = tk.Button(
                selector,
                text="🗑️ Eliminar Base de Datos",
                font=("Consolas", 12),
                bg="#333",
                fg="#00FF00",
                command=on_delete,
            )
            delete_btn.pack(pady=10)

        except Exception as e:
            output_box.insert(
                tk.END, f"\n❌ Error al listar las bases de datos: {str(e)}\n"
            )

    threading.Thread(target=task).start()


def delete_selected_database(db_name, output_box):
    output_box.delete(1.0, tk.END)
    output_box.insert(tk.END, f"🗑️ Eliminando base de datos '{db_name}'...\n\n")

    def task():
        try:
            # Primero detenemos el contenedor que usa la base de datos
            output_box.insert(tk.END, f"🛑 Deteniendo contenedor '{db_name}'...\n")
            stop_command = f"vagrant ssh -c 'docker stop {db_name}'"
            output_box.insert(tk.END, f"Ejecutando: {stop_command}\n")

            process = subprocess.Popen(
                stop_command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )

            for line in process.stdout:
                output_box.insert(tk.END, line)
                output_box.see(tk.END)

            # Ahora sí eliminamos la base de datos
            output_box.insert(tk.END, "🗑️ Eliminando base de datos anterior...\n")
            drop_command = (
                f"vagrant ssh -c 'docker exec ldb dropdb -U odoo --if-exists {db_name}'"
            )
            output_box.insert(tk.END, f"Ejecutando: {drop_command}\n")

            process = subprocess.Popen(
                drop_command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            for line in process.stdout:
                output_box.insert(tk.END, line)
                output_box.see(tk.END)

            output_box.insert(
                tk.END, f"\n✅ Base de datos '{db_name}' eliminada correctamente.\n"
            )
        except Exception as e:
            output_box.insert(
                tk.END, f"\n❌ Error al eliminar la base de datos: {str(e)}\n"
            )

    threading.Thread(target=task).start()


def toggle_fullscreen():
    state = root.attributes("-fullscreen")
    root.attributes("-fullscreen", not state)
    if state:  # Si estaba en pantalla completa, restauramos a un tamaño razonable
        root.geometry("1024x768")


def restore_database(output_box):
    output_box.delete(1.0, tk.END)
    output_box.insert(tk.END, "🔄 Preparando restauración de base de datos...\n\n")

    def select_project():
        # Obtener la lista de proyectos (carpetas) disponibles
        default_path = os.path.join(os.getcwd(), "dev")
        if not os.path.exists(default_path):
            os.makedirs(default_path)

        folders = [
            d
            for d in os.listdir(default_path)
            if os.path.isdir(os.path.join(default_path, d))
        ]

        # Crear selector de proyecto
        selector = tk.Toplevel(root)
        selector.title("Seleccionar Proyecto Destino")
        selector.geometry("400x300")
        selector.configure(bg="#1e1e1e")

        tk.Label(
            selector,
            text="Selecciona el proyecto donde restaurar:",
            font=("Consolas", 12),
            bg="#1e1e1e",
            fg="#00FF00",
        ).pack(pady=5)

        listbox = tk.Listbox(
            selector,
            bg="#333",
            fg="#00FF00",
            font=("Consolas", 12),
            selectmode=tk.SINGLE,
        )
        listbox.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        for folder in folders:
            listbox.insert(tk.END, folder)

        def on_project_select():
            if listbox.curselection():
                selected_project = listbox.get(listbox.curselection())
                selector.destroy()
                select_backup_file(selected_project)

        select_btn = tk.Button(
            selector,
            text="✅ Seleccionar Proyecto",
            font=("Consolas", 12),
            bg="#333",
            fg="#00FF00",
            command=on_project_select,
        )
        select_btn.pack(pady=10)

    def select_backup_file(project_name):
        # Crear ventana de selección personalizada
        selector = tk.Toplevel(root)
        selector.title("Seleccionar Archivo de Respaldo")
        selector.geometry("600x400")
        selector.configure(bg="#1e1e1e")

        tk.Label(
            selector,
            text="Selecciona el archivo de respaldo:",
            font=("Consolas", 12),
            bg="#1e1e1e",
            fg="#00FF00",
        ).pack(pady=5)

        # Frame para la lista y scrollbar
        frame = tk.Frame(selector, bg="#1e1e1e")
        frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        listbox = tk.Listbox(
            frame,
            bg="#333",
            fg="#00FF00",
            font=("Consolas", 12),
            selectmode=tk.SINGLE,
        )
        scrollbar = tk.Scrollbar(frame, orient="vertical", command=listbox.yview)
        listbox.configure(yscrollcommand=scrollbar.set)

        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # Obtener y ordenar archivos
        path = os.path.expanduser("~")
        files = []
        for f in os.listdir(path):
            if f.endswith(".zip"):
                full_path = os.path.join(path, f)
                files.append((full_path, os.path.getmtime(full_path)))

        # Ordenar por fecha de modificación (más reciente primero)
        files.sort(key=lambda x: x[1], reverse=True)

        # Mostrar archivos con fecha
        for file_path, mtime in files:
            from datetime import datetime

            date_str = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M")
            display_name = f"{date_str} - {os.path.basename(file_path)}"
            listbox.insert(tk.END, display_name)
            # Guardar el path completo como dato asociado
            listbox.insert(tk.END, file_path)

        def on_select():
            if listbox.curselection():
                idx = listbox.curselection()[0]
                # El path completo está en el siguiente índice
                selected_file = listbox.get(idx + 1)
                selector.destroy()
                process_backup_file(selected_file, project_name)

        select_btn = tk.Button(
            selector,
            text="✅ Seleccionar Archivo",
            font=("Consolas", 12),
            bg="#333",
            fg="#00FF00",
            command=on_select,
        )
        select_btn.pack(pady=10)

    def process_backup_file(backup_file, project_name):
        def task():
            try:
                # Preparar directorio temporal en la carpeta dev local
                output_box.insert(tk.END, "📁 Preparando archivos...\n")
                local_temp = os.path.join(os.getcwd(), "dev", "temp")
                os.makedirs(local_temp, exist_ok=True)

                # Copiar el ZIP a la carpeta dev/temp
                output_box.insert(tk.END, "📤 Copiando archivo ZIP...\n")
                shutil.copy2(backup_file, os.path.join(local_temp, "backup.zip"))

                # Extraer el ZIP localmente
                output_box.insert(tk.END, "📦 Extrayendo archivo ZIP...\n")
                with zipfile.ZipFile(
                    os.path.join(local_temp, "backup.zip"), "r"
                ) as zip_ref:
                    zip_ref.extractall(local_temp)

                # Verificar que el dump.sql existe
                dump_path = os.path.join(local_temp, "dump.sql")
                if not os.path.exists(dump_path):
                    raise Exception("No se encontró el archivo dump.sql en el ZIP")

                # Construir el nombre de la base de datos
                user_dev = os.getenv("USERDEV", "controlcdms-gh")
                db_name = f"{project_name}-local-{user_dev}"

                # Detener el contenedor si existe
                output_box.insert(tk.END, f"🛑 Deteniendo contenedor '{db_name}'...\n")
                stop_command = f"vagrant ssh -c 'docker stop {db_name}'"
                subprocess.run(stop_command, shell=True)

                # Eliminar base de datos si existe
                output_box.insert(tk.END, "🗑️ Eliminando base de datos anterior...\n")
                drop_command = f"vagrant ssh -c 'docker exec ldb dropdb -U odoo --if-exists {db_name}'"
                output_box.insert(tk.END, f"Ejecutando: {drop_command}\n")
                process = subprocess.Popen(
                    drop_command,
                    shell=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                for line in process.stdout:
                    output_box.insert(tk.END, line)
                    output_box.see(tk.END)

                # Crear nueva base de datos
                output_box.insert(tk.END, "🆕 Creando nueva base de datos...\n")
                create_command = (
                    f"vagrant ssh -c 'docker exec ldb createdb -U odoo {db_name}'"
                )
                output_box.insert(tk.END, f"Ejecutando: {create_command}\n")
                process = subprocess.Popen(
                    create_command,
                    shell=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                for line in process.stdout:
                    output_box.insert(tk.END, line)
                    output_box.see(tk.END)

                # Restaurar datos usando el archivo en /home/vagrant/dev/temp/dump.sql
                output_box.insert(tk.END, "📥 Restaurando datos...\n")

                # Primero copiamos el dump al contenedor
                copy_to_container = f"vagrant ssh -c 'docker cp /home/vagrant/dev/temp/dump.sql ldb:/tmp/dump.sql'"
                output_box.insert(
                    tk.END, f"Copiando dump al contenedor: {copy_to_container}\n"
                )
                process = subprocess.Popen(
                    copy_to_container,
                    shell=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                for line in process.stdout:
                    output_box.insert(tk.END, line)
                    output_box.see(tk.END)

                # Ahora restauramos usando la ruta dentro del contenedor
                restore_command = (
                    f"vagrant ssh -c 'docker exec ldb "
                    f"psql -U odoo -f /tmp/dump.sql {db_name}'"
                )
                output_box.insert(tk.END, f"Ejecutando: {restore_command}\n")
                process = subprocess.Popen(
                    restore_command,
                    shell=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                for line in process.stdout:
                    output_box.insert(tk.END, line)
                    output_box.see(tk.END)

                # Después de restaurar la base de datos, actualizamos el filestore
                output_box.insert(tk.END, "📁 Actualizando filestore...\n")

                # Verificar que existe el filestore en el ZIP extraído
                local_filestore = os.path.join(local_temp, "filestore")
                if not os.path.exists(local_filestore):
                    output_box.insert(
                        tk.END, "⚠️ No se encontró carpeta filestore en el backup\n"
                    )
                else:
                    # Definir la ruta del filestore en la máquina virtual
                    vm_filestore_path = (
                        f"/opt/odoo/staging/{db_name}/filestore/{db_name}"
                    )

                    # Primero eliminamos el filestore existente en la máquina virtual
                    delete_command = f"vagrant ssh -c 'sudo rm -rf {vm_filestore_path}'"
                    output_box.insert(
                        tk.END, f"Eliminando filestore existente: {delete_command}\n"
                    )
                    process = subprocess.Popen(
                        delete_command,
                        shell=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                    )
                    for line in process.stdout:
                        output_box.insert(tk.END, line)
                        output_box.see(tk.END)

                    # Mover el nuevo filestore a la máquina virtual
                    move_filestore = (
                        f"vagrant ssh -c 'sudo mv "
                        f"/home/vagrant/dev/temp/filestore {vm_filestore_path}'"
                    )
                    output_box.insert(
                        tk.END, f"Moviendo nuevo filestore: {move_filestore}\n"
                    )
                    process = subprocess.Popen(
                        move_filestore,
                        shell=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                    )
                    for line in process.stdout:
                        output_box.insert(tk.END, line)
                        output_box.see(tk.END)

                    output_box.insert(
                        tk.END, "✅ Filestore actualizado correctamente\n"
                    )

                # Esperar un momento
                output_box.insert(tk.END, "⏳ Finalizando...\n")
                time.sleep(5)

                # Limpiar archivos temporales
                # shutil.rmtree(local_temp, ignore_errors=True)

                output_box.insert(
                    tk.END,
                    f"\n✅ Base de datos restaurada correctamente en '{db_name}'.\n",
                )

            except Exception as e:
                output_box.insert(
                    tk.END, f"\n❌ Error al restaurar la base de datos: {str(e)}\n"
                )

        threading.Thread(target=task).start()

    select_project()


class FileDialog(filedialog.Open):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def show(self):
        # Ordenar archivos por fecha de modificación
        self.master.tk.call(
            "tk_getOpenFile",
            "-sortcmd",
            self.master.register(
                lambda x, y: int(os.path.getmtime(y)) - int(os.path.getmtime(x))
            ),
        )
        return super().show()


def show_specific_container_logs(output_box):
    output_box.delete(1.0, tk.END)
    output_box.insert(tk.END, "🔍 Buscando contenedores...\n\n")

    def get_containers():
        # Crear selector de contenedor
        selector = tk.Toplevel(root)
        selector.title("Seleccionar Contenedor")
        selector.geometry("400x300")
        selector.configure(bg="#1e1e1e")

        tk.Label(
            selector,
            text="Selecciona el contenedor para ver logs:",
            font=("Consolas", 12),
            bg="#1e1e1e",
            fg="#00FF00",
        ).pack(pady=5)

        listbox = tk.Listbox(
            selector,
            bg="#333",
            fg="#00FF00",
            font=("Consolas", 12),
            selectmode=tk.SINGLE,
        )
        listbox.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        # Obtener lista de contenedores
        process = subprocess.Popen(
            ["vagrant", "ssh", "-c", "docker ps --format '{{.Names}}'"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        containers = []
        for line in process.stdout:
            container = line.strip()
            if container:
                containers.append(container)
                listbox.insert(tk.END, container)

        def on_select():
            if listbox.curselection():
                selected_container = listbox.get(listbox.curselection())
                selector.destroy()
                show_logs(selected_container)

        select_btn = tk.Button(
            selector,
            text="📋 Ver Logs",
            font=("Consolas", 12),
            bg="#333",
            fg="#00FF00",
            command=on_select,
        )
        select_btn.pack(pady=10)

    def show_logs(container_name):
        output_box.delete(1.0, tk.END)
        output_box.insert(tk.END, f"📋 Mostrando logs de {container_name}...\n\n")

        def task():
            process = subprocess.Popen(
                ["vagrant", "ssh", "-c", f"docker logs -f {container_name} --tail 300"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            for line in process.stdout:
                output_box.insert(tk.END, line)
                output_box.see(tk.END)

        threading.Thread(target=task).start()

    get_containers()


# GUI
root = tk.Tk()
root.title("LGD Thingker – Terminal Mágica")
# Iniciar en modo restaurado con un tamaño razonable
root.geometry("1024x768")
root.configure(bg="#1e1e1e")

# Binding para Escape
root.bind("<Escape>", lambda e: toggle_fullscreen())

# Frame para los botones
button_frame = tk.Frame(root, bg="#1e1e1e")
button_frame.pack(fill="y", padx=10, side="left")

select_repo_btn = tk.Button(
    button_frame,
    text="📂 Seleccionar Repositorio",
    font=("Consolas", 14),
    bg="#333",
    fg="#00FF00",
    activebackground="#444",
    command=select_repository,
    width=25,
)
select_repo_btn.pack(pady=5)

start_btn = tk.Button(
    button_frame,
    text="✨ Verificando estado...",
    font=("Consolas", 14),
    bg="#333",
    fg="#888888",
    activebackground="#444",
    width=25,
)
start_btn.pack(pady=5)

logs_btn = tk.Button(
    button_frame,
    text="📋 Ver logs del contenedor",
    font=("Consolas", 14),
    bg="#333",
    fg="#00FF00",
    activebackground="#444",
    command=lambda: show_container_logs(output_box),
    width=25,
)
logs_btn.pack(pady=5)

halt_btn = tk.Button(
    button_frame,
    text="⏹️ Detener máquina virtual",
    font=("Consolas", 14),
    bg="#333",
    fg="#888888",  # Inicialmente en gris
    activebackground="#444",
    command=lambda: run_vagrant_halt(output_box),
    width=25,
    state="disabled",  # Inicialmente deshabilitado
)
halt_btn.pack(pady=5)

ports_btn = tk.Button(
    button_frame,
    text="🔗 Listar Enlaces",
    font=("Consolas", 14),
    bg="#333",
    fg="#00FF00",
    activebackground="#444",
    command=lambda: list_container_ports(output_box),
    width=25,
)
ports_btn.pack(pady=5)

delete_db_btn = tk.Button(
    button_frame,
    text="🗑️ Eliminar Base de Datos",
    font=("Consolas", 14),
    bg="#333",
    fg="#00FF00",
    activebackground="#444",
    command=lambda: show_databases(output_box),
    width=25,
)
delete_db_btn.pack(pady=5)

restore_db_btn = tk.Button(
    button_frame,
    text="📥 Restaurar Base de Datos",
    font=("Consolas", 14),
    bg="#333",
    fg="#00FF00",
    activebackground="#444",
    command=lambda: restore_database(output_box),
    width=25,
)
restore_db_btn.pack(pady=5)

fullscreen_btn = tk.Button(
    button_frame,
    text="🔲 Pantalla Completa",
    font=("Consolas", 14),
    bg="#333",
    fg="#00FF00",
    activebackground="#444",
    command=toggle_fullscreen,
    width=25,
)
fullscreen_btn.pack(pady=5)

container_logs_btn = tk.Button(
    button_frame,
    text="📋 Ver logs por contenedor",
    font=("Consolas", 14),
    bg="#333",
    fg="#00FF00",
    activebackground="#444",
    command=lambda: show_specific_container_logs(output_box),
    width=25,
)
container_logs_btn.pack(pady=5)

output_box = scrolledtext.ScrolledText(
    root,
    wrap=tk.WORD,
    font=("Consolas", 11),
    bg="#000000",
    fg="#00FF00",
    insertbackground="#00FF00",
)
output_box.pack(expand=True, fill="both", padx=(5, 10), pady=10)

start_btn.config(command=lambda: run_vagrant_up(output_box))


# Añadir después de la creación de todos los widgets pero antes del mainloop
def initial_check():
    update_start_button_state()


# Añadir al final del archivo, justo antes de root.mainloop()
initial_check()

root.mainloop()
