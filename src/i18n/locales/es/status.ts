import type en from '../en/status';

const es: typeof en = {
    loading: 'Tomando la primera muestra…',
    state: {
        live: 'En directo',
        paused: 'En pausa',
        pausedHint: 'La actualización se detiene mientras esta pestaña o la ventana están ocultas.',
        stale: 'Desactualizado',
        staleHint: 'Estos valores son de las {time}; la última actualización no se completó.',
        error: 'Error'
    },
    updated: 'Actualizado {ago}',
    ago: {
        now: 'ahora mismo',
        seconds: 'hace {count} s',
        minutes: 'hace {count} min',
        hours: 'hace {count} h'
    },
    refresh: 'Actualizar ahora',
    retry: 'Reintentar ahora',
    errorTitle: 'No se pudo actualizar el estado',
    loadErrorTitle: 'No se pudo cargar el estado',
    retryIn: 'Nuevo intento en {seconds} s',
    unavailable: 'Sin datos',
    limitedWindows: 'Este usuario no es administrador, y por SSH Windows solo deja usar WMI a los administradores: no se informa de la carga del procesador, los archivos de paginación, los procesos ni los usuarios conectados.',
    tone: {
        warn: 'Nivel alto',
        critical: 'Nivel crítico'
    },
    limits: 'Aviso desde {warn}, crítico desde {critical}',
    health: {
        label: 'Salud: {state}',
        lastKnown: 'Última lectura: {state}',
        labelStale: 'Salud a las {time}, sin actualizar: {state}',
        issuesLabel: 'Qué requiere atención',
        ok: 'Sin problemas',
        warn: 'Requiere atención',
        critical: 'Crítico',
        unknown: 'Desconocido',
        okDetail: 'CPU, carga, memoria, discos y servicios están dentro de sus límites.',
        unknownDetail: 'El equipo no ha informado de ninguna de las métricas en las que se basa la salud.',
        issues: {
            cpu: 'CPU {value}',
            load: 'Carga de {value} por núcleo',
            memory: 'Memoria {value}',
            disk: '{mount} al {value}',
            diskTotal: 'Almacenamiento al {value}',
            failedUnits: '{count} unidades con fallo',
            failedUnitsOne: '1 unidad con fallo'
        },
        more: '{count} más'
    },
    facts: {
        label: 'Sistema',
        hostname: 'Nombre del equipo',
        os: 'Sistema operativo',
        kernel: 'Kernel {value}',
        version: 'Versión {value}',
        uptime: 'Encendido desde hace {value}',
        users: '{count} usuarios conectados',
        usersOne: '1 usuario conectado',
        usersNone: 'Nadie conectado',
        failedUnits: '{count} unidades con fallo',
        failedUnitsOne: '1 unidad con fallo',
        noFailedUnits: 'Sin unidades con fallo',
        failedUnitsHint: 'Unidades de systemd en estado de fallo (systemctl --failed)'
    },
    cpu: {
        title: 'CPU',
        cores: '{count} núcleos',
        coresOne: '1 núcleo',
        iowait: 'Espera de E/S {value}'
    },
    memory: {
        title: 'Memoria',
        used: '{used} / {total}',
        available: '{value} disponibles',
        swap: 'Swap {used} / {total}',
        noSwap: 'Sin swap'
    },
    storage: {
        title: 'Almacenamiento',
        used: '{used} / {total}',
        free: '{free} libres',
        hint: 'El sistema de archivos local más lleno, con el total de todos debajo',
        fullest: 'Sistema de archivos más lleno, {mount}',
        total: '{count} sistemas de archivos · {used} / {total} en total',
        filesystems: 'Sistemas de archivos',
        caption: 'Sistemas de archivos locales y su uso',
        none: 'No se ha informado de ningún sistema de archivos local.'
    },
    load: {
        title: 'Carga media',
        hint: 'Media de procesos listos para ejecutarse en 1, 5 y 15 minutos, frente al número de núcleos',
        one: '1 min',
        five: '5 min',
        fifteen: '15 min',
        meter: 'Carga media en {window}',
        value: '{value} con {cores}',
        notch: '{cores} · muesca en {value}: todos los núcleos ocupados',
        coresUnknown: 'Núcleos sin datos · muesca en {value}: un núcleo ocupado'
    },
    chart: {
        stats: 'media {avg} · pico {max}',
        collecting: 'Tomando muestras…',
        showTable: '{label}: ver como tabla',
        showChart: '{label}: ver como gráfico',
        time: 'Hora',
        summary: '{label}, últimas {count} muestras: mínimo {min}, máximo {max}, ahora {now}',
        noData: '{label}: aún no hay muestras',
        tableCaption: '{label}, de la más reciente a la más antigua',
        cpu: 'Uso de CPU',
        memory: 'Uso de memoria',
        network: 'Tráfico de red'
    },
    network: {
        rx: 'Recibido',
        tx: 'Enviado',
        interfaces: 'Interfaces',
        interface: 'Interfaz'
    },
    processes: {
        title: 'Procesos principales',
        caption: 'Procesos que más CPU usaron durante la última muestra',
        cpuHint: 'CPU en {seconds} s · 100 % = un núcleo',
        cpuHintShare: 'CPU en {seconds} s · 100 % = los {count} núcleos',
        cpuPerCore: '{value} de un núcleo',
        name: 'Proceso',
        pid: 'PID',
        cpu: 'CPU',
        memory: 'Memoria',
        sortBy: 'Ordenar por {column}',
        cpuShare: '{value} de toda la máquina',
        memoryShare: '{value} de la memoria',
        none: 'No se han recibido datos de procesos.'
    },
    uptime: {
        days: '{d} d {h} h',
        hours: '{h} h {m} min',
        minutes: '{m} min'
    },
    footnote: 'Se actualiza cada {seconds} s mientras esta pestaña está visible. Solo se cuentan los sistemas de archivos locales.'
};

export default es;
