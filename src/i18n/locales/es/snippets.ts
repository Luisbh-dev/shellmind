import type en from '../en/snippets';

const es: typeof en = {
    title: 'Snippets',
    subtitle: 'Comandos guardados y pasos de runbook, con {{variables}} que rellenas antes de ejecutar.',
    search: 'Buscar snippets',
    showAllScopes: 'Incluir snippets de otros servidores',
    tagFilter: 'Filtrar por etiqueta',
    clearTags: 'Quitar',
    listLabel: 'Snippets',
    loading: 'Cargando snippets…',
    loadFailed: 'No se han podido cargar los snippets.',
    retry: 'Reintentar',
    copyName: '{name} (copia)',
    empty: {
        noMatch: 'Ningún snippet coincide con estos filtros.',
        library: 'Tu biblioteca está vacía. Guarda los comandos que usas a menudo y reutilízalos en cualquier servidor.',
        short: 'Todavía no hay snippets.'
    },
    actions: {
        new: 'Nuevo snippet',
        starters: 'Snippets de ejemplo',
        edit: 'Editar snippet',
        duplicate: 'Duplicar snippet',
        delete: 'Eliminar snippet',
        runIn: 'Ejecutar en {server}',
        runInTerminal: 'Ejecutar en el terminal',
        runOnMany: 'Ejecutar en varios servidores…',
        openInMultiExec: 'Abrir en ejecución múltiple…',
        copy: 'Copiar'
    },
    scope: {
        global: 'Todos los servidores',
        globalHint: 'Disponible en cualquier servidor',
        onlyOn: 'Solo {server}'
    },
    detail: {
        template: 'Plantilla',
        command: 'Comando',
        preview: 'Comando que se ejecutará',
        noServer: 'Selecciona una conexión para ejecutarlo en su terminal.',
        noTerminal: 'Esta conexión no tiene terminal.',
        otherServer: 'Este snippet pertenece a {server}. Duplícalo para todos los servidores si quieres ejecutarlo aquí.',
        noMultiExec: 'La ejecución múltiple solo funciona en servidores SSH, y este snippet pertenece a {server}.',
        secretsHidden: 'Los valores secretos se ocultan: el registro de auditoría y el historial del terminal guardan su {{placeholder}}, y el chat de IA lee el terminal con ellos enmascarados. Si se escribe en un terminal, la shell sigue mostrando el valor en pantalla.'
    },
    variables: {
        title: 'Variables',
        required: 'Obligatoria',
        empty: '(vacío)',
        missing: 'Escribe un valor.',
        requiredHint: 'Sin valor por defecto.',
        defaultHint: 'Por defecto: {value}',
        secret: 'Secreta',
        markSecret: 'Tratar {name} como secreta',
        secretHint: 'Secreta: nunca se registra ni se recuerda.',
        fillIn: 'Rellena: {list}'
    },
    editor: {
        newTitle: 'Nuevo snippet',
        editTitle: 'Editar snippet',
        name: 'Nombre',
        namePlaceholder: 'Reiniciar el stack web',
        nameRequired: 'Ponle un nombre al snippet.',
        description: 'Descripción',
        descriptionPlaceholder: 'Qué hace y cuándo usarlo',
        command: 'Comando',
        commandRequired: 'Escribe el comando que se ejecutará.',
        commandHint: 'Admite scripts de varias líneas. Usa {example} para un valor que se pide antes de ejecutar, {exampleDefault} para uno con valor por defecto o {exampleSecret} para un secreto (nunca se registra); escribe {escaped} para dejar las llaves tal cual. Las plantillas de Go ({{.Names}}, {{end}}) no se tocan.',
        noVariables: 'Sin variables.',
        variables: 'Variables: {list}',
        secretVariable: '{name} (secreta)',
        tags: 'Etiquetas',
        tagsHint: 'Separa las etiquetas con comas.',
        tagsPlaceholder: 'disco, nginx, semanal',
        scope: 'Disponible en',
        save: 'Guardar snippet'
    },
    delete: {
        title: 'Eliminar snippet',
        message: '«{name}» se quitará de tu biblioteca.',
        confirm: 'Eliminar'
    },
    toasts: {
        created: 'Snippet guardado',
        updated: 'Snippet actualizado',
        deleted: 'Snippet eliminado',
        deleteFailed: 'No se ha podido eliminar el snippet',
        imported: 'Snippets importados: {count}',
        skipped: 'Ya estaban en tu biblioteca: {count}',
        importFailed: 'No se han podido importar los snippets',
        sent: 'Enviado al terminal de {server}',
        queued: 'Esperando al terminal de {server}: se ejecuta en cuanto la sesión esté conectada, o se descarta pasados {minutes} minutos',
        copied: 'Comando copiado',
        copyFailed: 'El portapapeles no está disponible'
    },
    errors: {
        nameRequired: 'Ponle un nombre al snippet.',
        nameTooLong: 'El nombre admite como máximo {max} caracteres.',
        commandRequired: 'Escribe el comando que se ejecutará.',
        commandTooLong: 'El comando admite como máximo {max} caracteres.',
        descriptionTooLong: 'La descripción admite como máximo {max} caracteres.',
        tagTooLong: 'Cada etiqueta admite como máximo {max} caracteres.',
        tooManyTags: 'Un snippet admite como máximo {max} etiquetas.',
        serverNotFound: 'El servidor de este snippet ya no existe. Elige otro.'
    },
    starters: {
        title: 'Snippets de ejemplo',
        introEmpty: 'Empieza tu biblioteca con algunas comprobaciones habituales. Pasan a ser tuyos: edítalos como quieras.',
        intro: 'Añade comprobaciones habituales a tu biblioteca. Se omiten los que ya tengas.',
        notNow: 'Ahora no',
        import: 'Importar seleccionados ({count})',
        diskUsage: {
            name: 'Uso de disco',
            description: 'Espacio ocupado en cada sistema de archivos real.'
        },
        topMemory: {
            name: 'Procesos que más memoria usan',
            description: 'Los procesos con mayor consumo de memoria.'
        },
        failedUnits: {
            name: 'Unidades de systemd con fallos',
            description: 'Servicios y unidades que han fallado.'
        },
        dockerPs: {
            name: 'Contenedores en ejecución',
            description: 'Contenedores Docker con su imagen, estado y puertos.'
        },
        tailSyslog: {
            name: 'Últimas líneas del log del sistema',
            description: 'Final del log del sistema (o de cualquier archivo).'
        },
        openPorts: {
            name: 'Puertos a la escucha',
            description: 'Sockets TCP y UDP esperando conexiones.'
        }
    }
};

export default es;
