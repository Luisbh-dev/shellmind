import type en from '../en/app';

const es: typeof en = {
    noConnection: 'Ninguna conexión seleccionada',
    reconnectHint: 'Han cambiado los datos de conexión. Vuelve a conectar la sesión para usarlos.',
    reorderFailed: 'No se pudo guardar el nuevo orden',
    sidebar: 'Conexiones',
    skipToWorkspace: 'Saltar al espacio de trabajo',
    chat: {
        open: 'Abrir chat',
        close: 'Cerrar chat',
        toggle: 'Chat de IA',
        panel: 'Chat de IA',
        disabledS3: 'El asistente de IA no está disponible para buckets S3'
    },
    palette: {
        open: 'Abrir la paleta de comandos',
        placeholder: 'Busca o ejecuta un comando…'
    },
    resize: {
        sidebar: 'Cambiar el ancho del panel de conexiones',
        chat: 'Cambiar el ancho del panel del chat'
    },
    openServers: {
        count: '{count} abiertas',
        countHint: 'Hasta {max} conexiones siguen abiertas en segundo plano, con sus sesiones.',
        closeTitle: '¿Cerrar {name}?',
        closeMessage: 'Al cerrar {name} se pierde este trabajo:',
        close: 'Cerrar {name}',
        evictTitle: '¿Cerrar {name} para hacer sitio?',
        evictMessage: 'Puede haber hasta {max} conexiones abiertas. Abrir {opening} cierra la que menos has usado últimamente, {name}, y con ella se pierde este trabajo:',
        work: {
            session: '1 sesión de terminal activa',
            sessions: '{count} sesiones de terminal activas',
            unsavedFile: 'Cambios sin guardar en {path}',
            transfer: '1 transferencia de archivos en curso',
            transfers: '{count} transferencias de archivos en curso'
        }
    },
    shortcuts: {
        palette: 'Paleta de comandos',
        paletteTerminal: 'Paleta de comandos, también dentro del terminal (allí Ctrl+K es del shell)',
        toggleChat: 'Mostrar u ocultar el chat de IA',
        settings: 'Ajustes',
        tabs: 'Cambiar de pestaña',
        regions: 'Moverse entre las conexiones, el espacio de trabajo y el chat de IA',
        regionsTerminal: 'Lo mismo desde dentro del terminal (allí F6 es del programa)',
        contextMenu: 'Abrir el menú de una conexión, una pestaña o el terminal',
        menuKey: 'Tecla de menú',
        groups: {
            general: 'General',
            actions: 'Herramientas',
            terminal: 'Terminal'
        },
        terminal: {
            copy: 'Copiar la selección',
            paste: 'Pegar',
            search: 'Buscar en la salida',
            toolbar: 'Ir a la barra de herramientas del terminal',
            renameTab: 'Renombrar la pestaña de terminal enfocada',
            closeTab: 'Cerrar la pestaña de terminal enfocada'
        }
    },
    tabs: {
        label: 'Espacio de trabajo',
        all: 'Todas las pestañas',
        terminal: 'Terminal',
        windowsShell: 'CMD / PowerShell',
        ssh: 'SSH',
        files: 'Archivos',
        status: 'Estado',
        rdp: 'RDP'
    },
    commandQueue: {
        one: 'Hay 1 comando esperando al terminal. Se ejecuta en cuanto la sesión esté conectada, o se descarta pasados {minutes} minutos.',
        many: 'Hay {count} comandos esperando al terminal. Se ejecutan en cuanto la sesión esté conectada, o se descartan pasados {minutes} minutos.',
        discard: 'Descartar',
        noServerHint: 'Los comandos se ejecutan en el terminal de la conexión activa.',
        discardedOnClose: 'Se han descartado los comandos en cola de {name} ({count})',
        expired: 'Los comandos en cola de {name} no se ejecutaron en {minutes} minutos y se han descartado ({count})'
    },
    ui: {
        showSecret: 'Mostrar contraseña',
        notifications: 'Notificaciones',
        removeTag: 'Quitar la etiqueta {tag}'
    },
    errorBoundary: {
        title: 'Algo ha fallado',
        description: 'ShellMind ha sufrido un error inesperado. Tus conexiones guardadas están a salvo: vuelve a intentarlo o recarga la aplicación.',
        retry: 'Reintentar',
        reload: 'Recargar la aplicación',
        copy: 'Copiar detalles',
        copied: 'Copiado',
        panelTitle: '{panel} ha dejado de funcionar',
        panelTitleGeneric: 'Este panel ha dejado de funcionar',
        reloadPanel: 'Recargar el panel',
        chunkFailed: 'No se pudo descargar su código. Comprueba la conexión con ShellMind y recarga el panel; si ShellMind se ha actualizado mientras tanto, recarga la aplicación.'
    }
};

export default es;
