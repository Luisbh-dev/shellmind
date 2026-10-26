import type en from '../en/files';

const es: typeof en = {
    connecting: 'Abriendo la sesión de archivos…',
    loading: 'Cargando…',
    toolbar: {
        up: 'Ir a la carpeta superior (Retroceso)',
        home: 'Ir a la carpeta de inicio',
        root: 'Ir a la carpeta raíz',
        refresh: 'Actualizar',
        newFolder: 'Nueva carpeta',
        upload: 'Subir archivos',
        editPath: 'Editar la ruta (Ctrl+L)',
        pathLabel: 'Ruta de la carpeta',
        breadcrumb: 'Carpeta actual',
        filter: 'Filtrar por nombre',
        clearFilter: 'Quitar el filtro',
        showHidden: 'Mostrar archivos ocultos',
        hideHidden: 'Ocultar archivos ocultos'
    },
    columns: {
        selectAll: 'Seleccionar todo',
        name: 'Nombre',
        size: 'Tamaño',
        modified: 'Modificado',
        permissions: 'Permisos',
        actions: 'Acciones'
    },
    sortBy: 'Ordenar por {column}',
    list: {
        label: 'Archivos de {path}',
        empty: 'Esta carpeta está vacía',
        emptyHint: 'Arrastra archivos aquí o usa Subir.',
        noMatches: 'Ningún elemento coincide con «{filter}»',
        hiddenOnly: 'Aquí solo hay elementos ocultos',
        showHiddenAction: 'Mostrar archivos ocultos',
        truncated: 'Se muestran las primeras {count} entradas de esta carpeta.',
        selectRow: 'Seleccionar {name}',
        link: 'enlace simbólico',
        summary: '{count} elementos',
        summaryOne: '1 elemento',
        selection: '{count} seleccionados ({size})',
        selectionOne: '1 seleccionado ({size})',
        keyboardHelp: 'Flechas para moverse, Mayús+flechas para seleccionar, Intro para abrir, Retroceso para subir, Supr para eliminar, F2 para renombrar, Ctrl+A para seleccionar todo.'
    },
    actions: {
        edit: 'Editar',
        download: 'Descargar',
        rename: 'Renombrar',
        delete: 'Eliminar',
        clearSelection: 'Quitar la selección',
        downloadSelected: 'Descargar ({count})',
        deleteSelected: 'Eliminar ({count})'
    },
    drop: {
        title: 'Suelta para subir',
        target: 'a {path}'
    },
    connection: {
        failedTitle: 'No se pudo abrir la sesión de archivos',
        closedTitle: 'La sesión de archivos se cerró',
        listFailedTitle: 'No se pudo listar esta carpeta',
        timeout: 'El servidor no respondió a tiempo.',
        lost: 'Se perdió la conexión con el backend de ShellMind. Reconectando…',
        unauthorized: 'El backend de ShellMind rechazó el token de acceso. Recarga la aplicación para volver a iniciar sesión.',
        retry: 'Reconectar',
        retryList: 'Reintentar',
        goRoot: 'Abrir la carpeta raíz'
    },
    hostKey: {
        title: 'La clave de host de {host} ha cambiado',
        explanation: 'El servidor presentó una clave distinta de la que se fijó la primera vez que te conectaste. Ocurre tras una reinstalación o una rotación de claves, pero también puede significar que alguien está interceptando la conexión. No se ha enviado nada al servidor.',
        keyType: 'Tipo de clave',
        expected: 'Huella fijada',
        actual: 'Huella presentada',
        trust: 'Confiar en la nueva clave y reconectar',
        confirmTitle: '¿Confiar en la nueva clave de host?',
        confirmMessage: 'Hazlo solo si sabes por qué cambió la clave de {host} (por ejemplo, porque reinstalaste el servidor). A partir de ahora solo se confiará en la clave {fingerprint}; cualquier otra se volverá a rechazar.',
        confirm: 'Confiar y reconectar',
        failed: 'No se pudo confiar en la nueva clave',
        changedAgain: 'La clave fijada volvió a cambiar mientras tanto. Compara las claves que se muestran ahora antes de confiar en una.'
    },
    insecure: {
        ftp: 'FTP sin cifrar: la contraseña y los archivos viajan en claro. Activa FTPS en los ajustes de la conexión si el servidor lo admite.',
        http: 'Este endpoint de S3 usa http://: las credenciales y los datos viajan sin cifrar.',
        dismiss: 'Ocultar este aviso'
    },
    errors: {
        NOT_CONNECTED: 'Sin conexión',
        NOT_FOUND: 'No encontrado',
        PERMISSION_DENIED: 'Permiso denegado',
        EXISTS: 'Ya existe',
        NOT_EMPTY: 'La carpeta no está vacía',
        NOT_A_FILE: 'No es un archivo',
        NOT_A_DIRECTORY: 'No es una carpeta',
        TOO_LARGE: 'Demasiado grande',
        CONFLICT: 'Cambió en el servidor',
        INVALID: 'Solicitud no válida',
        CANCELLED: 'Cancelado',
        TIMEOUT: 'Tiempo de espera agotado',
        PARTIAL: 'Completado en parte',
        UNSUPPORTED: 'El servidor no lo admite',
        BUSY: 'No hay ninguna conexión libre',
        NOT_ATOMIC: 'Solo se puede sobrescribir directamente',
        FAILED: 'Error'
    },
    // Where downloads are saved (see saveTarget.ts).
    download: {
        tooLargeForMemory: '{name} ocupa {size}: es demasiado grande para descargarlo aquí. Este navegador guarda la descarga en memoria hasta que termina, y eso permite {limit} como máximo. La aplicación de escritorio y los navegadores basados en Chromium (Chrome, Edge) guardan los archivos grandes directamente en el disco.',
        tooLargeInsecure: '{name} ocupa {size}: es demasiado grande para descargarlo aquí. Esta página no se sirve por HTTPS, así que el navegador guarda la descarga en memoria hasta que termina, y eso permite {limit} como máximo. Para guardar archivos grandes directamente en el disco, abre ShellMind por HTTPS (o en localhost) en un navegador basado en Chromium (Chrome, Edge), o usa la aplicación de escritorio.',
        writeFailed: 'No se pudo escribir en el archivo elegido: {message}'
    },
    client: {
        noAnswer: 'El servidor no respondió a tiempo.',
        connectionLost: 'Se perdió la conexión con el backend de ShellMind.',
        stalled: 'No llegó nada durante un minuto, así que se detuvo la descarga.'
    },
    toast: {
        navigateFailed: 'No se pudo abrir {path}',
        folderCreated: 'Carpeta creada',
        createFailed: 'No se pudo crear la carpeta',
        renamed: 'Renombrado a {name}',
        renameFailed: 'No se pudo renombrar',
        deleted: 'Se eliminaron {count} elementos',
        deletedOne: 'Se eliminó 1 elemento',
        deletePartial: 'No se pudieron eliminar {failed} elementos',
        deletePartialOne: 'No se pudo eliminar 1 elemento',
        deleteFailed: 'No se pudo eliminar',
        foldersSkipped: 'Las carpetas no se pueden descargar; se omitieron {count}',
        refreshFailed: 'No se pudo actualizar la carpeta'
    },
    nameDialog: {
        newFolderTitle: 'Nueva carpeta',
        newFolderDescription: 'Dentro de {path}',
        renameTitle: 'Renombrar',
        renameDescription: 'Nombre actual: {name}',
        label: 'Nombre',
        create: 'Crear',
        rename: 'Renombrar',
        problems: {
            empty: 'Escribe un nombre.',
            slash: 'Un nombre no puede contener «/».',
            dots: '«.» y «..» no son nombres válidos.',
            tooLong: 'El nombre es demasiado largo: 255 bytes como máximo, y las letras con tilde y los símbolos ocupan de dos a cuatro cada uno.',
            keyTooLong: 'El nombre es demasiado largo para esta carpeta: su ruta completa en el bucket puede ocupar 1024 bytes como máximo, y las letras con tilde y los símbolos ocupan de dos a cuatro cada uno.',
            exists: 'Ya hay algo con este nombre aquí.'
        }
    },
    deleteDialog: {
        title: '¿Eliminar {count} elementos?',
        titleOne: '¿Eliminar «{name}»?',
        counting: 'Contando lo que se eliminará…',
        contents: 'Se eliminarán definitivamente {files} y {dirs} ({size}).',
        contentsAtLeast: 'Se eliminarán definitivamente al menos {files} y {dirs} ({size}); el recuento se detuvo ahí.',
        fileCount: '{count} archivos',
        fileCountOne: '1 archivo',
        folderCount: '{count} carpetas',
        folderCountOne: '1 carpeta',
        countFailed: 'No se pudo contar el contenido. Se eliminará todo lo que hay dentro de las carpetas seleccionadas.',
        filesOnly: 'Se eliminarán definitivamente {count} archivos ({size}).',
        fileOnly: 'Se eliminará definitivamente el archivo ({size}).',
        irreversible: 'Esta acción no se puede deshacer.',
        confirm: 'Eliminar',
        more: 'y {count} más'
    },
    overwriteDialog: {
        title: 'Ya existen {count} elementos',
        titleOne: '«{name}» ya existe',
        description: 'En {path}. ¿Qué hacemos con los archivos existentes?',
        replace: 'Reemplazar',
        skip: 'Omitir',
        keepBoth: 'Conservar ambos',
        folderClash: 'Hay una carpeta con este nombre; solo se puede conservar o renombrar la subida.',
        more: 'y {count} más'
    },
    transfers: {
        title: 'Transferencias',
        active: '{count} en curso',
        upload: 'Subida',
        download: 'Descarga',
        queued: 'En espera',
        waiting: 'Esperando una conexión libre',
        done: 'Completada',
        failed: 'Fallida',
        cancelled: 'Cancelada',
        cancel: 'Cancelar {name}',
        retry: 'Reintentar {name}',
        dismiss: 'Quitar {name} de la lista',
        clearFinished: 'Limpiar terminadas',
        collapse: 'Contraer transferencias',
        expand: 'Expandir transferencias',
        progress: '{name}: {percent} %',
        inPlaceHint: 'La carpeta no admite escritura, así que el archivo solo se puede sobrescribir directamente. Si esa subida se interrumpe, el archivo quedará dañado.',
        inPlace: 'Sobrescribir {name} directamente',
        needsTarget: '¿Dónde guardarlo?',
        chooseTarget: 'Elegir dónde guardar {name}'
    }
};

export default es;
