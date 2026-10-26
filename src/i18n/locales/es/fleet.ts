import type en from '../en/fleet';

const es: typeof en = {
    title: 'Salud de la flota',
    description: {
        on: '{count} servidores SSH, revisados cada {interval}',
        onOne: '1 servidor SSH, revisado cada {interval}',
        reach: '{count} servidores SSH · accesibilidad cada {interval} · revisiones de salud desactivadas',
        reachOne: '1 servidor SSH · accesibilidad cada {interval} · revisiones de salud desactivadas',
        off: '{count} servidores SSH · revisiones automáticas desactivadas',
        offOne: '1 servidor SSH · revisiones automáticas desactivadas'
    },
    interval: {
        minutes: '{count} min',
        hour: '1 hora'
    },
    state: {
        ok: 'Sin problemas',
        warn: 'Aviso',
        critical: 'Crítico',
        unreachable: 'Inaccesible',
        error: 'Revisión fallida',
        unknown: 'Desconocido',
        up: 'Accesible',
        upRdp: 'Solo RDP',
        unchecked: 'Sin revisar',
        checking: 'Revisando…'
    },
    tone: {
        warn: 'aviso',
        critical: 'crítico'
    },
    filters: {
        all: 'Todos',
        attention: 'Requieren atención',
        search: 'Filtrar servidores',
        searchPlaceholder: 'Nombre, dirección, grupo o etiqueta',
        reboot: 'Reinicio pendiente',
        security: 'Actualizaciones de seguridad',
        groupBy: 'Agrupar por',
        groupNone: 'Sin agrupar',
        groupGroup: 'Grupo',
        groupTag: 'Etiqueta',
        clear: 'Quitar filtros'
    },
    groups: {
        none: 'Sin grupo',
        untagged: 'Sin etiqueta',
        count: '{count} servidores',
        countOne: '1 servidor'
    },
    columns: {
        state: 'Estado',
        server: 'Servidor',
        cpu: 'CPU / carga',
        cpuHint: 'Windows: carga del procesador. Linux: carga media de un minuto por núcleo (1 significa que todos los núcleos están ocupados).',
        memory: 'Memoria',
        disk: 'Disco más lleno',
        failed: 'Unidades con fallo',
        failedHint: 'Unidades de systemd en estado failed',
        reboot: 'Reinicio',
        updates: 'Actualizaciones',
        updatesHint: 'Actualizaciones pendientes según la caché de paquetes; la revisión nunca la refresca.',
        uptime: 'Encendido',
        lastSeen: 'Visto por última vez',
        actions: 'Acciones',
        sort: 'Ordenar por {column}'
    },
    values: {
        perCore: '{value}/núcleo',
        loadHint: 'Carga {one} · {five} · {fifteen} con {cores} núcleos',
        diskHint: '{free} libres de {total}',
        memoryHint: '{available} disponibles de {total}',
        rebootPending: 'Pendiente',
        rebootNotNeeded: 'No hace falta',
        unknown: 'Sin datos',
        updatesNone: 'Al día',
        updatesSecurity: '{count} de seguridad',
        updatesFrom: 'Caché de {manager} del {when}',
        updatesManager: 'Caché de {manager}',
        never: 'Nunca',
        seenAt: 'Visto por última vez {when}',
        checkedAt: 'Revisado por última vez {when}',
        nextCheck: 'Próxima revisión {when}',
        latency: 'Conexión SSH en {value} ms',
        bootedAt: 'Arrancado el {when}',
        readAt: 'Salud leída {when}',
        sshSeenAt: 'SSH respondió por última vez {when}',
        sshNever: 'SSH nunca ha respondido',
        updatesCount: '{count} actualizaciones',
        updatesCountOne: '1 actualización'
    },
    errors: {
        EXEC_TIMEOUT: 'La revisión no terminó a tiempo: puede que el servidor esté sobrecargado.',
        CHECK_TIMEOUT: 'La revisión no terminó a tiempo: puede que el servidor esté sobrecargado.',
        STATUS_UNAVAILABLE: 'El servidor respondió, pero no se pudo leer su informe.',
        SSH_CHANNEL_REFUSED: 'El servidor rechazó otra sesión SSH (ha llegado a su límite MaxSessions).',
        NOT_SSH: 'Algo responde en el puerto SSH, pero no es un servidor SSH.',
        viaJump: 'Servidor de salto {name}: {reason}'
    },
    notes: {
        auth: 'Credenciales rechazadas. Las revisiones automáticas se han detenido para no bloquear la cuenta: corrige la conexión y vuelve a revisarlo.',
        hostKey: 'La clave del host ha cambiado. Las revisiones automáticas se han detenido: abre el terminal para comparar las claves y confiar en la nueva.',
        config: 'La conexión guardada no se puede usar tal como está. Las revisiones automáticas se han detenido hasta que se corrija.',
        excluded: 'Excluido de las revisiones automáticas',
        unreachableSince: 'Visto por última vez {when}',
        neverReached: 'Nunca se ha alcanzado',
        up: 'Su servidor SSH responde (comprobado sin iniciar sesión). Revísalo ahora para leer su salud.',
        rdpOnly: 'Solo responde su puerto de Escritorio remoto: su puerto SSH no, así que el terminal, Estado, la ejecución múltiple y las revisiones de salud no pueden alcanzarlo.',
        sshStopped: 'Solo responde su puerto de Escritorio remoto: su servidor SSH respondió {when}, pero ahora no. El terminal, Estado, la ejecución múltiple y las revisiones de salud lo necesitan.',
        behindJump: 'Detrás de un servidor de salto: solo lo alcanzan las revisiones de salud, que inician sesión.'
    },
    blocked: {
        jumpAuth: 'A la espera del servidor de salto {name}: se rechazaron sus credenciales. Corrígelas para revisar este servidor.',
        jumpHostKey: 'A la espera del servidor de salto {name}: su clave de host ha cambiado. Confía en la nueva clave para revisar este servidor.',
        jumpConfig: 'A la espera del servidor de salto {name}: su conexión guardada no se puede usar tal como está.',
        login: 'En pausa: el usuario «{user}» se acaba de rechazar en {count} servidores seguidos, así que sus demás servidores esperan para que no se bloquee la cuenta. Revisa este ahora para probarlo.',
        identity: 'En pausa: su identidad guardada se acaba de rechazar en {count} servidores seguidos, así que sus demás servidores esperan para que no se bloquee la cuenta. Revisa este ahora para probarlo.'
    },
    actions: {
        checkAll: 'Revisar todos ahora',
        checkAllHint: 'Una revisión de salud de cada servidor vigilado, salvo los que tienen las revisiones detenidas o a la espera',
        checkNow: 'Revisar {name} ahora',
        checkJump: 'Revisar ahora el servidor de salto {name}',
        fix: 'Corregir la conexión de {name}',
        fixJump: 'Corregir la conexión del servidor de salto {name}',
        compareKeys: 'Comparar las claves de host de {name}',
        askAiHeld: 'Corrige antes la conexión: al abrir el servidor se vuelve a iniciar sesión con las credenciales rechazadas.',
        more: 'Más acciones para {name}',
        openStatus: 'Abrir estado',
        openTerminal: 'Abrir terminal',
        openOperations: 'Abrir operaciones',
        edit: 'Editar la conexión',
        exclude: 'Excluir de las revisiones automáticas',
        include: 'Incluir en las revisiones automáticas',
        settings: 'Ajustes de la vigilancia',
        open: 'Abrir {name}'
    },
    askAi: {
        prompt: '{name} aparece como «{state}» en el panel de la flota ({details}). ¿Qué está pasando y qué debería revisar primero?',
        promptPlain: '{name} aparece como «{state}» en el panel de la flota. ¿Qué está pasando y qué debería revisar primero?'
    },
    off: {
        title: 'Las revisiones automáticas están desactivadas',
        text: 'Actívalas para revisar cada servidor SSH cada {interval} con un breve script de solo lectura a través de su conexión guardada. Las revisiones aparecen en los registros de autenticación de los servidores y las credenciales rechazadas nunca se reintentan por sí solas.',
        enable: 'Activar',
        checkOnce: 'Revisar todos una vez',
        reachTitle: 'Solo se comprueba la accesibilidad',
        reachText: 'ShellMind comprueba que cada servidor responde, sin iniciar sesión. Activa las revisiones de salud para leer CPU, memoria, discos, unidades con fallo y actualizaciones cada {interval}: inician sesión con la conexión guardada de cada servidor, así que aparecen en sus registros de autenticación. Las credenciales rechazadas nunca se reintentan por sí solas.',
        enableHealth: 'Activar las revisiones de salud'
    },
    empty: {
        noServers: 'Todavía no hay servidores SSH',
        noServersText: 'Los servidores Linux y Windows que añadas aparecerán aquí con su salud.',
        noMatch: 'Ningún servidor coincide con estos filtros.',
        allGood: 'Nada requiere atención',
        allGoodText: 'Todos los servidores revisados están dentro de sus límites.'
    },
    summary: {
        label: 'Servidores por estado'
    },
    feed: {
        offline: 'Actualizaciones en directo en pausa, reconectando…',
        loading: 'Cargando la flota…'
    },
    toasts: {
        refreshFailed: 'No se pudieron iniciar las revisiones',
        nothingToCheck: 'No hay servidores que revisar',
        saveFailed: 'No se pudieron guardar los ajustes de la flota',
        jumpHost: 'Revisa antes el servidor de salto',
        jumpHostText: '{name} espera a su servidor de salto, que tiene las revisiones detenidas.'
    },
    settings: {
        heading: 'Salud de la flota',
        loadFailed: 'No se pudieron cargar los ajustes de la flota.',
        reachability: 'Comprobar que los servidores responden, sin iniciar sesión',
        reachabilityHint: 'Se conecta al puerto SSH de cada servidor accesible directamente y lee su saludo, como mucho cada {interval}. Si el puerto SSH de un servidor Windows no responde, también cuenta que responda su puerto de Escritorio remoto, y el panel indica que solo responde el Escritorio remoto. Sin iniciar sesión, así que nunca llega a los registros de autenticación; los servidores detrás de un servidor de salto quedan fuera.',
        reachabilityCovered: 'Las revisiones de salud ya indican si cada servidor responde.',
        enabled: 'Revisar su salud en segundo plano (inicia sesión)',
        enabledHint: 'Un breve script de solo lectura se ejecuta en cada servidor Linux y Windows a través de su conexión SSH guardada, unos pocos servidores a la vez. Aparece en sus registros de autenticación; las credenciales rechazadas y las claves de host cambiadas nunca se reintentan por sí solas, y un usuario rechazado en varios servidores seguidos no se prueba en los demás.',
        interval: 'Revisar cada',
        notifications: 'Avisarme cuando un servidor pase a crítico o inaccesible',
        notificationsHint: 'Una notificación de escritorio mientras ShellMind está en segundo plano y un mensaje en la aplicación cuando está delante. Cada servidor avisa como mucho una vez cada 30 minutos.',
        notificationsDenied: 'Las notificaciones de esta página están bloqueadas en los ajustes del navegador.',
        notificationsAllow: 'Permitir notificaciones de escritorio',
        excluded: '{count} servidores están excluidos de las revisiones automáticas.',
        excludedOne: '1 servidor está excluido de las revisiones automáticas.',
        includeAll: 'Volver a incluirlos',
        note: 'Las revisiones se hacen mientras ShellMind está en marcha y guardan el último resultado de cada servidor. Sirve para priorizar, no es un sistema de monitorización.'
    },
    alerts: {
        critical: '{name} está en estado crítico',
        unreachable: '{name} está inaccesible',
        many: '{count} servidores requieren atención',
        reasonUnreachable: 'Sin conexión SSH: {reason}'
    },
    sidebar: {
        health: 'Salud: {state}',
        checked: 'revisado {when}'
    }
};

export default es;
