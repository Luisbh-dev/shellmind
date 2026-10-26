import type en from '../en/audit';

const es: typeof en = {
    title: 'Registro de auditoría',
    subtitle: 'Comandos ejecutados desde ShellMind: IA, snippets, ejecución múltiple y acciones de operaciones.',
    loading: 'Cargando…',
    loadFailed: 'No se ha podido cargar el registro de auditoría.',
    retry: 'Reintentar',
    refresh: 'Actualizar',
    count: 'Entradas: {count}',
    countMore: 'Mostrando las {count} entradas más recientes',
    noServer: 'Sin servidor',
    toggleDetails: 'Ver detalles',
    copyCommand: 'Copiar comando',
    reportedByClient: 'notificado',
    reportedByClientHint: 'Lo notificó la interfaz tras escribir el comando en un terminal; no lo registró el backend por sí mismo.',
    copied: 'Comando copiado',
    copyFailed: 'El portapapeles no está disponible',
    loadOlder: 'Cargar entradas anteriores',
    filters: {
        search: 'Buscar',
        searchPlaceholder: 'Comando o servidor',
        server: 'Servidor',
        allServers: 'Todos los servidores',
        source: 'Origen',
        allSources: 'Todos los orígenes',
        from: 'Desde',
        to: 'Hasta',
        clear: 'Quitar filtros'
    },
    columns: {
        details: 'Detalles',
        time: 'Fecha',
        server: 'Servidor',
        source: 'Origen',
        command: 'Comando',
        exit: 'Salida',
        actions: 'Acciones'
    },
    empty: {
        none: 'Todavía no hay nada registrado. Aquí aparecen los comandos ejecutados desde el chat de IA, los snippets, la ejecución múltiple y los paneles de operaciones.',
        filtered: 'Ninguna entrada coincide con estos filtros.'
    },
    export: {
        csv: 'Exportar CSV',
        done: 'Entradas exportadas: {count}',
        truncated: 'Solo se exportaron las {max} entradas más recientes. Acota los filtros para exportar el resto.',
        failed: 'No se ha podido exportar el registro de auditoría'
    },
    retention: {
        label: 'Conservar entradas',
        days: '{count} días',
        year: '1 año',
        forever: 'Sin límite de tiempo',
        foreverHint: 'Hasta las {max} entradas más recientes',
        confirmTitle: '¿Eliminar las entradas antiguas?',
        confirmMessage: 'Las entradas de más de {period} se eliminan ahora y cada día a partir de ahora. Las {max} entradas más recientes se conservan siempre.',
        confirm: 'Conservar {period}',
        saved: 'Las entradas se conservan {period}',
        savedForever: 'Las entradas se conservan sin límite de tiempo',
        pruned: 'Se han eliminado {count} entradas antiguas',
        prunedOne: 'Se ha eliminado 1 entrada antigua',
        failed: 'No se ha podido cambiar la conservación'
    },
    sources: {
        'ai-run': 'IA',
        'ai-autorun': 'IA automática',
        snippet: 'Snippet',
        'multi-exec': 'Ejecución múltiple',
        ops: 'Operaciones',
        terminal: 'Terminal',
        fleet: 'Flota',
        identity: 'Identidad',
        rdp: 'Escritorio remoto'
    }
};

export default es;
