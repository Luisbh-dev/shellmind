import type en from '../en/patch';

const es: typeof en = {
    title: 'Centro de parches',
    action: 'Centro de parches',
    serverAction: 'Actualizaciones de este servidor (centro de parches)',
    description: {
        servers: '{count} servidores SSH',
        serversOne: '1 servidor SSH',
        pending: '{count} actualizaciones pendientes',
        pendingOne: '1 actualización pendiente',
        security: '{count} de seguridad',
        reboot: '{count} necesitan reinicio',
        rebootOne: '1 necesita reinicio'
    },
    view: 'Actualizaciones',
    filters: {
        label: 'Mostrar',
        all: 'Todos',
        security: 'Actualizaciones de seguridad',
        updates: 'Actualizaciones pendientes',
        reboot: 'Reinicio pendiente',
        attention: 'Requieren atención',
        unscanned: 'Sin analizar',
        search: 'Filtrar servidores',
        searchPlaceholder: 'Nombre, dirección, grupo, etiqueta o gestor',
        clear: 'Quitar filtros'
    },
    columns: {
        select: 'Seleccionar',
        selectAll: 'Seleccionar todos los servidores mostrados',
        server: 'Servidor',
        manager: 'Gestor',
        pending: 'Pendientes',
        security: 'Seguridad',
        reboot: 'Reinicio',
        lastUpdate: 'Última actualización',
        lists: 'Listas de paquetes',
        status: 'Estado'
    },
    managers: {
        apt: 'apt',
        dnf: 'dnf',
        yum: 'yum',
        zypper: 'zypper',
        apk: 'apk',
        pacman: 'pacman',
        'windows-update': 'Windows Update'
    },
    values: {
        unknown: 'Desconocido',
        estimated: 'Según la última revisión de Salud de la flota (no un análisis): analiza el servidor para ver su lista.',
        noSecurityInfo: 'Este gestor de paquetes no indica qué actualizaciones corrigen problemas de seguridad.',
        rebootRequired: 'Necesario',
        rebootNo: 'No',
        never: 'Nunca',
        stale: 'Estas listas de paquetes tienen más de una semana: actualízalas para ver las actualizaciones actuales.',
        listsMissing: 'Nunca descargadas'
    },
    status: {
        scanning: 'Analizando…',
        running: 'Parcheando',
        notScanned: 'Sin analizar',
        upToDate: 'Al día',
        sudoPassword: 'sudo pide contraseña',
        noPrivilege: 'Necesita root o sudo',
        listOnly: 'Solo listado'
    },
    actions: {
        scanAll: 'Analizar todos',
        scanSelected: 'Analizar seleccionados ({count})',
        scanHint: 'Lee las actualizaciones pendientes de cada servidor desde su caché de paquetes (solo lectura: no instala ni actualiza nada). Los servidores que rechazaron el inicio de sesión se dejan fuera hasta que los analices por separado.',
        patchSelected: 'Parchear seleccionados ({count})',
        patchSelectedOne: 'Parchear seleccionado (1)',
        patchNone: 'Selecciona primero los servidores que quieres parchear',
        open: 'Actualizaciones de {name}',
        openRow: '{name}: actualizaciones',
        closeDetails: 'Cerrar las actualizaciones de {name}',
        rescan: 'Analizar de nuevo',
        rescanHint: 'Lee las actualizaciones pendientes de este servidor desde su caché de paquetes (solo lectura).',
        refresh: 'Actualizar listas de paquetes',
        refreshHint: 'Ejecuta apt-get update, dnf makecache, zypper refresh, apk update o pacman -Sy como root o con sudo -n, y vuelve a analizar.',
        refreshWindows: 'Buscar en Windows Update',
        refreshWindowsHint: 'Consulta ahora Windows Update (o WSUS). Puede tardar unos minutos.',
        installSecurity: 'Instalar las de seguridad…',
        installAll: 'Instalar todas…',
        openCenter: 'Abrir el centro de parches',
        showRun: 'Ver la ejecución',
        backToServers: 'Volver a los servidores',
        audit: 'Registro de auditoría'
    },
    summary: {
        windowsLists: 'Última búsqueda',
        scanned: 'Analizado {when}',
        privilege: 'Instala como'
    },
    privilege: {
        root: 'root',
        sudo: 'sudo sin contraseña',
        'sudo-password': 'sudo pide contraseña',
        none: 'sin root ni sudo',
        admin: 'Administrador',
        user: 'usuario estándar'
    },
    notes: {
        sudoPassword: 'sudo le pide contraseña a este usuario. ShellMind solo instala actualizaciones como root o con un sudo que no pida contraseña para ningún comando (sudo -n); nunca escribe contraseñas. Dale al usuario una regla de sudoers con NOPASSWD: ALL (no basta con una limitada al gestor de paquetes: la ejecución también usa env, apt-mark, needrestart y el comando de reinicio) o guarda el servidor con root.',
        noPrivilege: 'Este usuario no es root ni tiene sudo: ShellMind puede listar las actualizaciones, pero no instalarlas.',
        windows: 'Aquí se listan las actualizaciones de Windows; ShellMind no las instala. Instálalas con Windows Update o WSUS.',
        noManager: 'No se ha encontrado ningún gestor de paquetes compatible (apt, dnf, yum, zypper, apk o pacman) en este servidor.',
        jumpHost: 'A otros servidores se llega a través de este ({names}): una ejecución de parches nunca lo reinicia.',
        noSecurity: '{manager} no indica qué actualizaciones corrigen problemas de seguridad: solo se pueden instalar «todas las actualizaciones».'
    },
    notices: {
        'metadata-missing': 'Las listas de paquetes nunca se han descargado en este servidor: actualízalas para ver sus actualizaciones.',
        'manager-busy': 'Hay otro gestor de paquetes en marcha ({detail}): una instalación lo espera (hasta 5 minutos con apt).',
        'security-unknown': 'Los repositorios no traen información de seguridad, así que no se pueden distinguir las actualizaciones de seguridad.',
        'listing-failed': 'No se han podido listar las actualizaciones.',
        truncated: 'Solo se listan las 2000 primeras de {detail} actualizaciones.',
        'search-failed': 'No se ha podido buscar en Windows Update.',
        'search-denied': 'Por SSH, Windows Update solo deja buscar a los administradores: guarda este servidor con una cuenta de administrador para ver sus actualizaciones.'
    },
    updates: {
        title: 'Actualizaciones pendientes',
        search: 'Filtrar actualizaciones',
        searchPlaceholder: 'Paquete, repositorio o versión',
        securityOnly: 'Solo seguridad',
        package: 'Paquete',
        installed: 'Instalada',
        available: 'Disponible',
        security: 'Seguridad',
        securityBadge: 'Seguridad',
        newPackage: 'nuevo',
        shown: '{shown} de {total}',
        showAll: 'Mostrar las {count}',
        empty: 'No hay actualizaciones pendientes',
        emptyText: 'Está instalado todo lo que conocen las listas de paquetes.',
        noMatch: 'Ninguna actualización coincide con el filtro',
        notScanned: 'Aún sin analizar',
        notScannedText: 'Analiza el servidor para leer sus actualizaciones pendientes (solo lectura).',
        scanFailed: 'El análisis ha fallado',
        scanFailedDetail: 'Detalle técnico',
        held: 'Retenidas ({count})',
        heldHint: 'apt las retiene: instalarlas eliminaría otros paquetes (una actualización completa, que se hace a mano), o Ubuntu las está desplegando por fases.',
        heldReason: {
            'kept-back': 'retenida',
            phased: 'por fases'
        },
        patches: 'Parches necesarios ({count})',
        rebootPackages: 'Piden el reinicio',
        restartServices: 'Servicios con bibliotecas desactualizadas',
        refreshOutput: 'Salida de la actualización de listas'
    },
    apply: {
        title: 'Parchear {count} servidores',
        titleOne: 'Parchear {name}',
        mode: 'Qué hacer',
        modes: {
            security: 'Actualizaciones de seguridad',
            securityHint: 'Solo las que los repositorios marcan como correcciones de seguridad.',
            all: 'Todas las actualizaciones',
            allHint: 'Todas las pendientes (apt: como apt upgrade, sin eliminar nunca paquetes).',
            refresh: 'Actualizar las listas de paquetes',
            refreshHint: 'Solo vuelve a descargar las listas de paquetes; no se instala nada.'
        },
        refreshFirst: 'Actualizar antes las listas de paquetes',
        refreshFirstHint: 'Si no, cada servidor instala lo que conocen ahora sus listas, tal y como mostró el análisis.',
        reboot: 'Reiniciar los servidores que lo necesiten y esperar a que vuelva SSH',
        rebootHint: 'Tras las actualizaciones, el servidor que indique un reinicio pendiente se reinicia; la ejecución espera a que vuelva a responder por SSH y lo comprueba (tiempo encendido, estado de systemd, unidades fallidas). Los hosts de salto nunca se reinician.',
        rebootWait: 'Esperar a SSH hasta',
        timeout: 'Tiempo por servidor',
        timeoutHint: 'Incluye actualizaciones, reinicio y espera.',
        timeoutHintReboot: 'Incluye actualizaciones, reinicio y espera: con esta espera a SSH, al menos {count} min.',
        minutes: '{count} min',
        review: 'Revisar',
        back: 'Atrás',
        start: 'Empezar a parchear {count} servidores',
        startOne: 'Empezar a parchear {name}',
        cancel: 'Cancelar'
    },
    preview: {
        loading: 'Calculando qué hará la ejecución…',
        heading: 'Qué va a pasar',
        summary: '{action} en {count} de {total} servidores.',
        summaryOne: '{action} en {name}.',
        actions: {
            security: 'Instalar las actualizaciones de seguridad',
            all: 'Instalar todas las actualizaciones',
            refresh: 'Actualizar las listas de paquetes'
        },
        refreshFirst: 'Primero se actualizan las listas de paquetes: los servidores pueden instalar más de lo que se cuenta aquí.',
        totals: '{pending} actualizaciones en total, {security} de ellas de seguridad, según el último análisis.',
        reboots: 'Los servidores que indiquen un reinicio pendiente tras instalar sus actualizaciones se reiniciarán, uno a uno según les toque.',
        rebootNow: 'Ya esperan un reinicio: {names}.',
        nothing: 'Ahora mismo no se puede parchear ninguno de estos servidores.',
        toInstall: 'A instalar',
        servers: 'Servidores',
        willRun: 'Se ejecuta',
        skipped: 'Se queda fuera',
        rebootPlan: {
            'if-required': 'Se reinicia si hace falta',
            off: 'Sin reinicio',
            'jump-host': 'Host de salto: sin reinicio'
        },
        commands: 'Comandos',
        commandsHint: 'Se ejecutan como root, o con sudo -n para otros usuarios. Todas las respuestas se dan por adelantado (-y, sin interacción) y se conservan los ficheros de configuración modificados.',
        script: 'Ver el script que ejecuta cada servidor',
        scanned: 'analizado {when}',
        confirmLabel: 'Escribe {count} para confirmar que quieres parchear {count} servidores',
        confirmHint: 'Parchear cambia servidores en marcha. La ejecución queda en el registro de auditoría.',
        oneConfirm: 'La ejecución queda en el registro de auditoría, y puedes seguirla, pausarla o cancelarla.'
    },
    skip: {
        'not-found': 'Eliminado',
        unsupported: 'No es un servidor SSH',
        windows: 'Windows: solo listado',
        'not-scanned': 'Sin analizar',
        'scan-failed': 'Su análisis falló',
        'no-manager': 'Sin gestor de paquetes compatible',
        privilege: 'Necesita root o sudo sin contraseña',
        'sudo-password': 'sudo pide contraseña',
        'no-security': 'Sin información de seguridad',
        'up-to-date': 'Nada que hacer',
        busy: 'Ya se está parcheando'
    },
    job: {
        title: 'Ejecución de parches',
        running: 'Hay una ejecución de parches en marcha en este servidor.',
        last: 'Última ejecución de parches'
    },
    history: {
        retry: 'Volver a parchear donde falló ({count})',
        retryHint: 'Abre el centro de parches con estos servidores: la ejecución se vuelve a planificar (vista previa, reinicio, registro de auditoría).',
        open: 'Abrir en el centro de parches'
    },
    output: {
        seconds: '{count} s',
        minutes: '{count} min',
        minutesSeconds: '{minutes} min {seconds} s',
        manager: 'Gestor de paquetes: {manager}.',
        refreshFailed: 'No se han podido actualizar las listas de paquetes (código de salida {code}); la ejecución sigue con las listas que tiene el servidor.',
        failed: 'El gestor de paquetes ha fallado (código de salida {code}).',
        noSecurityUpdates: 'No hay actualizaciones de seguridad pendientes.',
        autoMarksFailed: 'No se han podido volver a marcar como automáticos los paquetes actualizados que se habían instalado como dependencias (código de salida {code}): ejecuta apt-mark auto con ellos.',
        rebootRequired: {
            yes: 'Hace falta reiniciar.',
            no: 'No hace falta reiniciar.',
            unknown: 'No se sabe si hace falta reiniciar.'
        },
        error: {
            privilege: 'Hace falta root o sudo sin contraseña (sudo -n) y este usuario no tiene ninguno de los dos: ShellMind nunca escribe contraseñas.',
            'no-manager': 'No se ha encontrado ningún gestor de paquetes compatible (apt, dnf, yum, zypper, apk o pacman).',
            'no-security': '{manager} no indica qué actualizaciones corrigen problemas de seguridad: instala todas las actualizaciones.',
            'reboot-privilege': 'Reiniciar requiere root o sudo sin contraseña (sudo -n).'
        },
        reboot: {
            start: 'Reiniciando el servidor.',
            waiting: 'Esperando a que vuelva SSH…',
            stillWaiting: 'Sigue esperando a SSH ({after})…',
            back: 'De vuelta tras {after}',
            up: 'encendido desde hace {up}',
            state: 'sistema {state}',
            failedUnits: '{count} unidades fallidas',
            failedUnitsOne: '1 unidad fallida',
            'skip-no-boot-id': 'Hace falta reiniciar, pero este servidor no permite distinguir un arranque del siguiente: no se reinicia.',
            'skip-unknown': 'No se reinicia: no se sabe si hace falta.',
            'skip-jump-host': 'Hace falta reiniciar, pero a otros servidores se llega a través de este: reinícialo por separado.'
        },
        check: {
            state: 'El sistema está «{state}» tras el reinicio.',
            failedUnits: 'Tras el reinicio fallan más unidades de systemd que antes ({before} antes, {after} ahora).',
            stillStarting: 'systemd sigue arrancando unidades después de {after}.'
        },
        rebootFailed: {
            command: 'El comando de reinicio ha fallado (código de salida {code}).',
            timeout: 'El servidor no ha respondido por SSH en los {wait} siguientes al reinicio.',
            sameBoot: 'El servidor no se ha reiniciado: {after} después del comando de reinicio sigue en el mismo arranque.',
            connection: 'Tras el reinicio no se ha podido conectar con el servidor: {detail}',
            check: 'El servidor ha vuelto, pero no se ha podido comprobar: {detail}',
            cancelled: 'Cancelado mientras se esperaba a que volviera el servidor.'
        },
        lastAttempt: 'Último intento: {detail}'
    },
    errors: {
        loadFailed: 'El centro de parches no ha podido cargar sus servidores.',
        scanFailed: 'No se han podido analizar los servidores.',
        previewFailed: 'No se ha podido planificar la ejecución.',
        startFailed: 'No se ha podido iniciar la ejecución.',
        PATCH_PRIVILEGE: 'Actualizar las listas de paquetes requiere root o sudo sin contraseña (sudo -n).',
        PATCH_REFRESH_FAILED: 'El gestor de paquetes no ha podido actualizar sus listas.',
        PATCH_BUSY: 'Hay una ejecución de parches en marcha en este servidor: espera a que termine.',
        PATCH_CONFIRM_MISMATCH: 'Los servidores han cambiado desde la revisión (ahora se ejecutaría en {expected}): revisa de nuevo la ejecución.',
        PATCH_NOTHING_TO_RUN: 'Ahora mismo no se puede parchear ninguno de estos servidores.',
        PATCH_UNSUPPORTED: 'El centro de parches solo lee servidores Linux y Windows (por SSH).',
        PATCH_SCAN_FAILED: 'No se han podido leer las actualizaciones del servidor.',
        MULTIEXEC_BUSY: 'Ya hay cuatro ejecuciones en marcha: espera a que termine alguna.'
    },
    empty: {
        noServers: 'Aún no hay servidores SSH',
        noServersText: 'Añade un servidor Linux o Windows para ver aquí sus actualizaciones.',
        noMatch: 'Ningún servidor coincide con los filtros'
    },
    toasts: {
        started: 'Ejecución de parches iniciada',
        startedText: '{count} servidores. Síguela aquí o en los trabajos de ejecución múltiple.',
        startedTextOne: '{name}. Síguela aquí o en los trabajos de ejecución múltiple.',
        refreshed: 'Listas de paquetes actualizadas'
    }
};

export default es;
