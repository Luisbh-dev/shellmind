import type en from '../en/ops';

const es: typeof en = {
    tab: 'Operaciones',
    viewsLabel: 'Vistas de operaciones',
    views: {
        services: 'Servicios',
        containers: 'Contenedores',
        compose: 'Compose',
        images: 'Imágenes',
        logs: 'Logs'
    },
    privilege: {
        root: 'root',
        rootHint: 'Sesión como root: las acciones se ejecutan directamente.',
        admin: 'Administrador',
        adminHint: 'Este usuario es administrador de Windows: puede iniciar y detener servicios.',
        sudo: 'sudo',
        sudoHint: 'Las acciones con privilegios se ejecutan con sudo sin contraseña (sudo -n).',
        user: 'Sin permisos de administrador',
        userHint: 'Este usuario no es root y no puede usar sudo sin contraseña: algunas acciones y logs pueden ser rechazados.',
        windowsUserHint: 'Este usuario no es administrador: es posible que no pueda iniciar ni detener servicios.'
    },
    redetect: 'Volver a comprobar el servidor',
    redetectFailed: 'No se pudo volver a comprobar el servidor; las vistas usan los resultados anteriores.',
    detecting: 'Comprobando qué ofrece este servidor…',
    retry: 'Reintentar',
    clearSearch: 'Borrar búsqueda',
    refresh: 'Actualizar',
    back: 'Volver a la lista',
    loading: 'Cargando…',
    errors: {
        unknown: 'Algo ha fallado.',
        EXEC_TIMEOUT: 'El servidor ha tardado demasiado en responder.',
        EXEC_STREAMS_BUSY: 'Esta conexión ya tiene el máximo de transmisiones en directo. Detén alguna primero.',
        EXEC_OUTPUT_TOO_LARGE: 'El comando ha mostrado demasiada salida y se ha detenido.',
        EXEC_ABORTED: 'Se ha cancelado el comando.',
        SSH_CHANNEL_REFUSED: 'El servidor ha rechazado otra sesión (ha llegado a su límite MaxSessions de SSH). Cierra una pestaña de terminal o de archivos de este servidor, o aumenta MaxSessions.',
        SSH_FAILED: 'No se pudo conectar con el servidor.',
        SSH_CLOSED: 'Se ha perdido la conexión con el servidor.',
        HOST_KEY_MISMATCH: 'La clave de host de este servidor ha cambiado. Revísala en Hosts conocidos antes de volver a conectar.',
        SECRET_UNREADABLE: 'Las credenciales guardadas no se pueden descifrar. Vuelve a introducirlas en los ajustes de la conexión.',
        OPS_PERMISSION_DENIED: 'El servidor ha rechazado la acción: faltan permisos.',
        OPS_COMMAND_FAILED: 'El comando ha fallado en el servidor.',
        OPS_UNSUPPORTED: 'No está disponible en este servidor.',
        OPS_INVALID_INPUT: 'Ese nombre o ruta no es válido.',
        OPS_NOT_FOUND: 'Ya no existe en el servidor.',
        STATUS_UNAVAILABLE: 'El servidor no ha devuelto un informe completo.',
        LOGS_LIMIT: 'Hay demasiadas transmisiones de logs abiertas. Detén alguna primero.',
        SERVER_NOT_FOUND: 'Este servidor ya no existe.',
        UNSUPPORTED_PURPOSE: 'No está disponible para este tipo de servidor.',
        JUMP_HOST: 'No se puede usar el host de salto de este servidor.',
        PRIVATE_KEY_FILE: 'No se puede leer el archivo de clave privada de este servidor.',
        INTERNAL: 'El backend ha sufrido un error inesperado; su log tiene los detalles.',
        COMPOSE_FILES_MISSING: 'Los archivos de Compose de este proyecto ya no están en el servidor.'
    },
    services: {
        noSystemd: 'Este servidor no usa systemd',
        noSystemdHint: 'La gestión de servicios necesita systemd (o un servidor Windows). Los logs en directo de archivos y contenedores siguen disponibles.',
        search: 'Buscar servicios',
        filterLabel: 'Mostrar servicios',
        filter: {
            all: 'Todos',
            running: 'En marcha',
            failed: 'Con fallo',
            stopped: 'Detenidos'
        },
        empty: 'Ningún servicio coincide.',
        limitedWindows: 'Por SSH, Windows solo deja listar los servicios a los administradores: estos son los que este usuario aún puede consultar, y a la mayoría no los puede iniciar ni detener.',
        caption: '{count} servicios',
        columns: {
            name: 'Servicio',
            state: 'Estado',
            startup: 'Arranque'
        },
        detailLabel: 'Servicio {name}',
        actionsLabel: 'Acciones del servicio',
        actions: {
            start: 'Iniciar',
            stop: 'Detener',
            restart: 'Reiniciar',
            reload: 'Recargar',
            enable: 'Habilitar',
            disable: 'Deshabilitar'
        },
        confirm: {
            start: { title: '¿Iniciar {name}?', message: 'El servicio se iniciará en el servidor.' },
            stop: { title: '¿Detener {name}?', message: 'El servicio se detiene ahora y lo que dependa de él puede dejar de funcionar.' },
            restart: { title: '¿Reiniciar {name}?', message: 'El servicio se detiene y vuelve a arrancar; se cortan las conexiones abiertas con él.' },
            reload: { title: '¿Recargar {name}?', message: 'El servicio vuelve a leer su configuración sin detenerse.' },
            enable: { title: '¿Habilitar {name}?', message: 'El servicio arrancará automáticamente al iniciar el sistema.' },
            disable: { title: '¿Deshabilitar {name}?', message: 'El servicio dejará de arrancar al iniciar el sistema. Sigue en marcha hasta que lo detengas.' },
            dependents: {
                stop: 'También se detendrán los servicios en marcha que dependen de él: {names}.',
                restart: 'Los servicios en marcha que dependen de él se detendrán durante el reinicio: {names}.',
                unknown: 'Los servicios que dependen de él también se detendrán.'
            }
        },
        done: {
            start: '{name} iniciado',
            stop: '{name} detenido',
            restart: '{name} reiniciado',
            reload: '{name} recargado',
            enable: '{name} habilitado',
            disable: '{name} deshabilitado'
        },
        failed: 'No se pudo cambiar {name}',
        journal: {
            title: 'Journal',
            lines: 'Líneas del journal que mostrar',
            follow: 'Seguir en directo',
            hint: 'Elige cuántas líneas recientes cargar o sigue el journal en directo.',
            empty: 'El journal no tiene entradas de esta unidad.'
        }
    },
    containers: {
        noEngine: 'No hay ningún motor de contenedores disponible',
        search: 'Buscar contenedores',
        filterLabel: 'Mostrar contenedores',
        filter: {
            all: 'Todos',
            running: 'En marcha',
            stopped: 'Detenidos'
        },
        stats: 'Consumo',
        projects: 'Proyectos de Compose',
        empty: 'Ningún contenedor coincide.',
        caption: '{count} contenedores',
        columns: {
            name: 'Contenedor',
            state: 'Estado',
            ports: 'Puertos',
            cpu: 'CPU',
            memory: 'Memoria',
            shell: 'Shell'
        },
        states: {
            running: 'en marcha',
            unhealthy: 'con fallos',
            exited: 'finalizado',
            stopped: 'detenido',
            created: 'creado',
            configured: 'configurado',
            initialized: 'inicializado',
            restarting: 'reiniciándose',
            paused: 'en pausa',
            removing: 'eliminándose',
            dead: 'muerto',
            unknown: 'desconocido'
        },
        statusText: {
            up: 'Lleva {duration}',
            exited: 'Salió con código {code} {ago}',
            restarting: 'Reiniciándose (código {code}) {ago}',
            created: 'Creado',
            health: {
                healthy: 'sano',
                unhealthy: 'con fallos',
                starting: 'comprobando su salud',
                paused: 'en pausa'
            }
        },
        detailLabel: 'Contenedor {name}',
        actionsLabel: 'Acciones del contenedor',
        askAi: 'Diagnosticar {name} con IA',
        shell: {
            open: 'Abrir shell',
            openIn: 'Abrir una shell en {name}',
            choose: 'Elegir la shell',
            with: 'Abrir {shell}',
            notRunning: 'Inicia el contenedor para abrir una shell en él.',
            linuxOnly: 'Las shells en contenedores están disponibles en servidores Linux.'
        },
        actions: {
            start: 'Iniciar',
            stop: 'Detener',
            restart: 'Reiniciar',
            remove: 'Eliminar'
        },
        confirm: {
            start: { title: '¿Iniciar {name}?', message: 'El contenedor se iniciará.' },
            stop: { title: '¿Detener {name}?', message: 'El contenedor se detiene; sus procesos tienen unos segundos para terminar.' },
            restart: { title: '¿Reiniciar {name}?', message: 'El contenedor se detiene y vuelve a arrancar.' },
            remove: { title: '¿Eliminar {name}?', message: 'El contenedor se detiene si está en marcha y después se borra. Los volúmenes con nombre se conservan. No se puede deshacer.' }
        },
        done: {
            start: '{name} iniciado',
            stop: '{name} detenido',
            restart: '{name} reiniciado',
            remove: '{name} eliminado'
        },
        failed: 'No se pudo cambiar {name}',
        fields: {
            status: 'Estado',
            id: 'ID',
            created: 'Creado',
            started: 'Iniciado',
            finished: 'Detenido',
            finishedValue: '{time} (código de salida {code})',
            oom: 'Memoria',
            oomValue: 'Terminado por quedarse sin memoria (OOM)',
            error: 'Error',
            command: 'Comando',
            restart: 'Política de reinicio',
            restartValue: '{policy} · reiniciado {count} veces',
            restartValueOne: '{policy} · reiniciado una vez',
            user: 'Usuario',
            workdir: 'Directorio de trabajo',
            compose: 'Compose'
        },
        sections: {
            overview: 'Resumen',
            health: 'Comprobación de salud',
            usage: 'Consumo actual',
            ports: 'Puertos',
            env: 'Entorno',
            mounts: 'Montajes',
            networks: 'Redes'
        },
        health: {
            healthy: 'Sano',
            starting: 'Arrancando',
            unhealthy: 'Con fallos',
            unknown: 'Desconocido',
            streak: 'Ha fallado {count} comprobaciones seguidas',
            streakOne: 'Ha fallado la última comprobación',
            exit: 'salida {code}'
        },
        usage: {
            stopped: 'El contenedor no está en marcha.',
            cpu: 'CPU',
            memory: 'Memoria',
            pids: 'Procesos',
            net: 'E/S de red',
            block: 'E/S de disco',
            measure: 'Volver a medir'
        },
        ports: {
            none: 'No expone ningún puerto.',
            notPublished: 'sin publicar',
            to: 'al puerto del contenedor'
        },
        env: {
            hint: 'Los valores están ocultos: suelen contener contraseñas y tokens.',
            showAll: 'Mostrar todos',
            hideAll: 'Ocultar todos',
            show: 'Mostrar el valor de {name}',
            hide: 'Ocultar el valor de {name}',
            copy: 'Copiar el valor de {name}',
            copied: 'Valor de {name} copiado',
            copyFailed: 'No se pudo copiar el valor',
            masked: 'valor oculto',
            empty: 'No hay variables de entorno.'
        },
        mounts: {
            none: 'No tiene nada montado.',
            readOnly: 'solo lectura',
            readWrite: 'lectura y escritura',
            volume: 'Volumen {name}'
        },
        networks: {
            none: 'No está conectado a ninguna red.',
            mode: 'Modo de red: {mode}',
            ip: 'Dirección IP',
            gateway: 'Puerta de enlace',
            aliases: 'Nombres'
        },
        logs: {
            title: 'Logs recientes',
            lines: 'Líneas de log que mostrar',
            follow: 'Seguir en directo',
            hint: 'Elige cuántas líneas recientes cargar o sigue los logs en directo.',
            empty: 'El contenedor no ha escrito ningún log.'
        },
        inspect: {
            title: 'Salida de inspect',
            masked: 'Los valores del entorno están ocultos.',
            revealed: 'Los valores del entorno se muestran.',
            reveal: 'Mostrar valores',
            mask: 'Ocultar valores'
        },
        viaSudo: 'En este servidor el motor de contenedores se usa a través de sudo -n.',
        detailUnavailable: 'No se pudieron leer los detalles.',
        gone: 'Este contenedor ya no aparece en la lista. Actualízala.'
    },
    compose: {
        search: 'Buscar proyectos',
        caption: '{count} proyectos de Compose',
        columns: {
            name: 'Proyecto',
            state: 'Contenedores',
            services: 'Servicios'
        },
        runningCount: '{running}/{total} en marcha',
        noDirectory: 'Directorio desconocido',
        empty: 'No hay proyectos de Compose',
        emptyHint: 'Los proyectos aparecen aquí cuando docker compose up (o podman-compose up) ha creado sus contenedores en este servidor.',
        noMatch: 'Ningún proyecto coincide.',
        readOnly: 'Se muestran los proyectos, pero las acciones no están disponibles: {problem}',
        noTool: 'Compose no está instalado en este servidor.',
        needsFiles: 'Necesita los archivos de Compose del proyecto, que ya no están en el servidor.',
        unusableName: 'ShellMind no ejecuta Compose para un proyecto con este nombre.',
        unusableNameNotice: 'Este nombre viene de una etiqueta del contenedor y tiene caracteres que los nombres de proyecto de Compose no usan, así que ShellMind no ejecuta comandos de Compose para él. Gestiónalo desde un terminal.',
        detailLabel: 'Proyecto de Compose {name}',
        actionsLabel: 'Acciones del proyecto',
        actions: {
            up: 'Levantar',
            update: 'Actualizar y recrear',
            restart: 'Reiniciar',
            stop: 'Detener',
            down: 'Bajar'
        },
        logs: 'Seguir logs',
        serviceLogs: 'Seguir sus logs',
        serviceActions: 'Acciones de {service}',
        running: '{action}: {name}…',
        runningSlow: '{action}: {name}… Descargar las imágenes puede tardar unos minutos.',
        lastRun: {
            ok: 'Última acción: {action}',
            failed: 'Ha fallado la última acción: {action}',
            noOutput: 'Sin salida.'
        },
        servicesLabel: 'Servicios del proyecto',
        servicesTitle: 'Contenedores · {count}',
        files: 'Archivos de Compose',
        noFiles: 'Los contenedores no indican qué archivos los crearon.',
        missing: '(no está)',
        filesMissing: 'Faltan archivos de Compose en el servidor',
        filesMissingShort: 'Faltan archivos de Compose',
        filesMissingHint: 'Levantar y Actualizar y recrear los necesitan. Detener, Reiniciar, Bajar y los logs siguen funcionando con el nombre del proyecto.',
        filesMissingHintPodman: 'podman-compose los necesita para cualquier acción.',
        tool: 'Se ejecuta con {tool}.',
        gone: 'Este proyecto ya no tiene contenedores (se ha bajado o eliminado). Para recuperarlo, ejecuta {command} en su directorio.',
        failed: 'No se pudo cambiar {name}',
        done: {
            up: '{name} levantado',
            update: '{name} actualizado y recreado',
            restart: '{name} reiniciado',
            stop: '{name} detenido',
            down: '{name} bajado'
        },
        confirm: {
            up: {
                title: '¿Levantar {name}?',
                message: 'Crea los contenedores de {name} que falten y recrea los que hayan cambiado de configuración o de imagen. Los que no han cambiado siguen en marcha.',
                serviceTitle: '¿Levantar {service} de {name}?',
                service: 'Crea o recrea {service} (y arranca los servicios de los que depende) a partir de los archivos de Compose del proyecto.'
            },
            update: {
                title: '¿Actualizar y recrear {name}?',
                message: 'Descarga las imágenes más recientes de {name} y recrea los contenedores cuya imagen o configuración haya cambiado. Esos servicios se reinician y se cortan sus conexiones abiertas.',
                serviceTitle: '¿Actualizar y recrear {service} de {name}?',
                service: 'Descarga la imagen más reciente de {service} y recrea su contenedor si ha cambiado. El servicio se reinicia.'
            },
            restart: {
                title: '¿Reiniciar {name}?',
                message: 'Todos los contenedores de {name} se detienen y vuelven a arrancar; se cortan las conexiones abiertas.',
                serviceTitle: '¿Reiniciar {service} de {name}?',
                service: 'Los contenedores de {service} se detienen y vuelven a arrancar.'
            },
            stop: {
                title: '¿Detener {name}?',
                message: 'Los contenedores de {name} se detienen. Se conservan: Levantar los vuelve a arrancar.',
                serviceTitle: '¿Detener {service} de {name}?',
                service: 'Los contenedores de {service} se detienen. Los servicios que dependen de él pueden dejar de funcionar.'
            },
            down: {
                title: '¿Bajar {name}?',
                message: 'Estos contenedores de {name} se detienen y se eliminan, junto con las redes del proyecto:',
                keep: 'Los volúmenes con nombre y las imágenes se conservan, pero los archivos escritos dentro de los contenedores (fuera de los volúmenes) se pierden. Después el proyecto sale de esta lista: recupéralo con {command} en su directorio.'
            }
        }
    },
    images: {
        search: 'Buscar imágenes',
        caption: '{count} imágenes',
        filterLabel: 'Mostrar imágenes',
        filter: {
            all: 'Todas',
            used: 'En uso',
            unused: 'Sin usar',
            dangling: 'Huérfanas'
        },
        columns: {
            image: 'Imagen',
            size: 'Tamaño',
            created: 'Creada',
            usage: 'Usada por',
            actions: 'Acciones'
        },
        untagged: 'sin etiqueta',
        dangling: 'huérfana',
        unused: 'sin usar',
        usedBy: '{count} contenedores',
        usedByOne: '1 contenedor',
        inUse: 'La usan {count} contenedores: elimínalos primero.',
        inUseOne: 'La usa un contenedor: elimínalo primero.',
        empty: 'No hay imágenes en este servidor.',
        noMatch: 'Ninguna imagen coincide.',
        remove: 'Eliminar',
        removeName: 'Eliminar {name}',
        removed: '{name} eliminada',
        removeFailed: 'No se pudo eliminar {name}',
        confirmRemove: {
            title: '¿Eliminar {name}?',
            tagged: 'Se quita la etiqueta {name} y, con ella, la imagen, salvo que otra etiqueta apunte a ella. Se volverá a descargar la próxima vez que haga falta.',
            untagged: 'Esta imagen sin etiqueta se borra. No se puede deshacer.'
        },
        cleanUp: 'Limpiar',
        usage: {
            title: 'Espacio en disco del motor de contenedores',
            failed: 'No se pudo leer el uso del disco.',
            images: 'Imágenes',
            containers: 'Contenedores',
            volumes: 'Volúmenes',
            'build-cache': 'Caché de compilación',
            reclaimable: '{size} recuperables',
            count: '{count} en total'
        },
        prune: {
            checking: 'Comprobando qué se eliminaría…',
            listLabel: 'Imágenes que se eliminarían',
            count: '{count} imágenes',
            countOne: '1 imagen',
            confirm: 'Eliminar {count} imágenes',
            confirmOne: 'Eliminar 1 imagen',
            failed: 'La limpieza ha fallado',
            freed: 'Se han liberado {size}.',
            estimate: {
                exact: 'libera unos {size}',
                'at-least': 'libera al menos {size}',
                'up-to': 'libera hasta {size}'
            },
            dangling: {
                menu: 'Eliminar imágenes huérfanas…',
                title: '¿Eliminar las imágenes huérfanas?',
                explain: 'Las imágenes huérfanas son restos sin etiqueta de compilaciones y descargas anteriores que ningún contenedor usa.',
                nothing: 'No hay imágenes huérfanas.',
                note: 'No se pueden recuperar, pero nada se ejecuta a partir de ellas.',
                done: 'Imágenes huérfanas eliminadas'
            },
            unused: {
                menu: 'Eliminar imágenes sin usar…',
                title: '¿Eliminar todas las imágenes sin usar?',
                explain: 'Se borran todas las imágenes que no usa ningún contenedor (en marcha o detenido), también las que tienen etiqueta.',
                nothing: 'Todas las imágenes las usa algún contenedor.',
                note: 'Se volverán a descargar o compilar la próxima vez que hagan falta: el próximo despliegue tardará más.',
                done: 'Imágenes sin usar eliminadas'
            },
            'build-cache': {
                menu: 'Vaciar la caché de compilación…',
                title: '¿Vaciar la caché de compilación?',
                explain: 'Se borra la caché de compilación, salvo lo que usa una compilación en curso y las capas que comparte con las imágenes (borrarlas no liberaría espacio).',
                nothing: 'La caché de compilación no tiene nada que se pueda liberar: lo que queda está en uso o lo comparten las imágenes.',
                note: 'Las próximas compilaciones se harán sin caché y tardarán más.',
                confirm: 'Vaciar la caché de compilación',
                done: 'Caché de compilación vaciada'
            }
        }
    },
    logs: {
        formLabel: 'Origen de los logs',
        kindLabel: 'Tipo de origen',
        kind: {
            journal: 'Journal',
            file: 'Archivo',
            container: 'Contenedor',
            compose: 'Compose'
        },
        inputLabel: {
            journal: 'Unidad (opcional)',
            file: 'Ruta del archivo',
            container: 'Nombre o ID del contenedor',
            compose: 'Proyecto de Compose, o proyecto/servicio'
        },
        placeholder: {
            journal: 'Unidad, p. ej. nginx (vacío: todo el journal)',
            file: '/var/log/syslog',
            fileWindows: 'C:\\logs\\app.log',
            container: 'Nombre o ID del contenedor',
            compose: 'Proyecto, o proyecto/servicio'
        },
        invalid: {
            journal: 'Escribe un nombre de unidad como nginx o nginx.service.',
            file: 'Escribe una ruta absoluta o dentro de tu home (~/logs/app.log), sin comillas ni caracteres especiales.',
            fileWindows: 'Escribe una ruta absoluta como C:\\logs\\app.log, sin comillas ni caracteres especiales.',
            container: 'Escribe un nombre o ID de contenedor (letras, números, "_", "." y "-").',
            compose: 'Escribe un nombre de proyecto, o proyecto/servicio (letras, números, "_", "." y "-").'
        },
        start: 'Iniciar',
        restart: 'Reiniciar',
        stop: 'Detener',
        status: {
            idle: 'Inactivo',
            connecting: 'Conectando',
            streaming: 'En directo',
            ended: 'Finalizado',
            endedCode: 'Finalizado (código {code})',
            error: 'Detenido por un error'
        },
        backendLost: 'Se ha perdido la conexión con ShellMind.',
        emptyTitle: 'Sigue un log en directo',
        emptyHint: 'Elige el journal, un archivo o un contenedor y pulsa Iniciar. Las líneas nuevas aparecen según se escriben.',
        count: '{count} líneas',
        countOne: '1 línea',
        countFiltered: '{shown} de {total} líneas',
        filter: 'Filtrar líneas',
        regex: 'Usar una expresión regular',
        badRegex: 'Expresión regular no válida: se busca como texto normal.',
        pause: 'Pausar',
        resume: 'Reanudar',
        follow: 'Mantener visible la línea más reciente',
        clear: 'Limpiar la vista',
        download: 'Descargar como archivo',
        maxLines: 'Líneas que conservar',
        maxLinesOption: '{count} mil',
        pausedCount: 'En pausa: {count} líneas nuevas en espera',
        discarded: 'Se han quitado {count} líneas antiguas para no superar el límite',
        dropped: 'Se han omitido {size} porque la vista no daba abasto',
        outputLabel: 'Salida del log',
        waiting: 'Esperando salida…',
        noLines: 'No hay líneas.'
    }
};

export default es;
